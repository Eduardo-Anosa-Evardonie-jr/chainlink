import {
  contract,
  matchers,
  helpers as h,
  setup,
} from '@chainlink/test-helpers'
import { assert } from 'chai'
import { StalenessFlaggingValidatorFactory } from '../../ethers/v0.7/StalenessFlaggingValidatorFactory'
import { FlagsFactory } from '../../ethers/v0.6/FlagsFactory'
import { SimpleWriteAccessControllerFactory } from '../../ethers/v0.6/SimpleWriteAccessControllerFactory'
import { MockV3AggregatorFactory } from '../../ethers/v0.6/MockV3AggregatorFactory'

let personas: setup.Personas
const provider = setup.provider()
const validatorFactory = new StalenessFlaggingValidatorFactory()
const flagsFactory = new FlagsFactory()
const acFactory = new SimpleWriteAccessControllerFactory()
const aggregatorFactory = new MockV3AggregatorFactory()

beforeAll(async () => {
  personas = await setup.users(provider).then((x) => x.personas)
})

describe('StalenessFlaggingValidator', () => {
  let validator: contract.Instance<StalenessFlaggingValidatorFactory>
  let flags: contract.Instance<FlagsFactory>
  let ac: contract.Instance<SimpleWriteAccessControllerFactory>

  const flaggingThreshold1 = 10000
  const flaggingThreshold2 = 20000

  const deployment = setup.snapshot(provider, async () => {
    ac = await acFactory.connect(personas.Carol).deploy()
    flags = await flagsFactory.connect(personas.Carol).deploy(ac.address)
    validator = await validatorFactory
      .connect(personas.Carol)
      .deploy(flags.address)

    await ac.connect(personas.Carol).addAccess(validator.address)
  })

  beforeEach(async () => {
    await deployment()
  })

  it('has a limited public interface', () => {
    matchers.publicAbi(validatorFactory, [
      'update',
      'check',
      'setThresholds',
      'setFlagsAddress',
      'threshold',
      'flags',
      // Owned methods:
      'acceptOwnership',
      'owner',
      'transferOwnership',
    ])
  })

  describe('#constructor', () => {
    it('sets the arguments passed in', async () => {
      assert.equal(await validator.flags(), flags.address)
    })

    it('sets the owner', async () => {
      assert.equal(await validator.owner(), personas.Carol.address)
    })
  })

  describe('#setFlagsAddress', () => {
    const newFlagsAddress = '0x0123456789012345678901234567890123456789'

    it('changes the flags address', async () => {
      assert.equal(flags.address, await validator.flags())

      await validator.connect(personas.Carol).setFlagsAddress(newFlagsAddress)

      assert.equal(newFlagsAddress, await validator.flags())
    })

    it('emits a log event only when actually changed', async () => {
      const tx = await validator
        .connect(personas.Carol)
        .setFlagsAddress(newFlagsAddress)
      const receipt = await tx.wait()
      const eventLog = matchers.eventExists(
        receipt,
        validator.interface.events.FlagsAddressUpdated,
      )

      assert.equal(flags.address, h.eventArgs(eventLog).previous)
      assert.equal(newFlagsAddress, h.eventArgs(eventLog).current)

      const sameChangeTx = await validator
        .connect(personas.Carol)
        .setFlagsAddress(newFlagsAddress)
      const sameChangeReceipt = await sameChangeTx.wait()
      assert.equal(0, sameChangeReceipt.events?.length)
      matchers.eventDoesNotExist(
        sameChangeReceipt,
        validator.interface.events.FlagsAddressUpdated,
      )
    })

    describe('when called by a non-owner', () => {
      it('reverts', async () => {
        await matchers.evmRevert(
          validator.connect(personas.Neil).setFlagsAddress(newFlagsAddress),
          'Only callable by owner',
        )
      })
    })
  })

  describe('#setThresholds', () => {
    let agg1: contract.Instance<MockV3AggregatorFactory>
    let agg2: contract.Instance<MockV3AggregatorFactory>
    let aggregators: Array<string>
    let thresholds: Array<number>

    beforeEach(async () => {
      const decimals = 8
      const initialAnswer = 10000000000
      agg1 = await aggregatorFactory
        .connect(personas.Carol)
        .deploy(decimals, initialAnswer)
      agg2 = await aggregatorFactory
        .connect(personas.Carol)
        .deploy(decimals, initialAnswer)
    })

    describe('failure', () => {
      beforeEach(() => {
        aggregators = [agg1.address, agg2.address]
        thresholds = [flaggingThreshold1]
      })

      it('reverts when called by a non-owner', async () => {
        await matchers.evmRevert(
          validator
            .connect(personas.Neil)
            .setThresholds(aggregators, thresholds),
          'Only callable by owner',
        )
      })

      it('reverts when passed uneven arrays', async () => {
        await matchers.evmRevert(
          validator
            .connect(personas.Carol)
            .setThresholds(aggregators, thresholds),
          'Different sized arrays',
        )
      })
    })

    describe('success', () => {
      let tx: any

      beforeEach(() => {
        aggregators = [agg1.address, agg2.address]
        thresholds = [flaggingThreshold1, flaggingThreshold2]
      })

      describe('when called with 2 new thresholds', () => {
        beforeEach(async () => {
          tx = await validator
            .connect(personas.Carol)
            .setThresholds(aggregators, thresholds)
        })

        it('sets the thresholds', async () => {
          const first = await validator.threshold(agg1.address)
          const second = await validator.threshold(agg2.address)
          assert.equal(first.toString(), flaggingThreshold1.toString())
          assert.equal(second.toString(), flaggingThreshold2.toString())
        })

        it('emits events', async () => {
          const firstEvent = await h.getLog(tx, 0)
          assert.equal(h.evmWordToAddress(firstEvent.topics[1]), agg1.address)
          assert.equal(firstEvent.topics[3], h.numToBytes32(flaggingThreshold1))
          const secondEvent = await h.getLog(tx, 1)
          assert.equal(h.evmWordToAddress(secondEvent.topics[1]), agg2.address)
          assert.equal(
            secondEvent.topics[3],
            h.numToBytes32(flaggingThreshold2),
          )
        })
      })

      describe('when called with 2, but 1 has not changed', () => {
        it('emits only 1 event', async () => {
          tx = await validator
            .connect(personas.Carol)
            .setThresholds(aggregators, thresholds)

          const newThreshold = flaggingThreshold2 + 1
          tx = await validator
            .connect(personas.Carol)
            .setThresholds(aggregators, [flaggingThreshold1, newThreshold])
          const logs = await h.getLogs(tx)
          assert.equal(logs.length, 1)
          const log = logs[0]
          assert.equal(h.evmWordToAddress(log.topics[1]), agg2.address)
          assert.equal(log.topics[2], h.numToBytes32(flaggingThreshold2))
          assert.equal(log.topics[3], h.numToBytes32(newThreshold))
        })
      })
    })
  })

  describe('#check', () => {
    let agg1: contract.Instance<MockV3AggregatorFactory>
    let agg2: contract.Instance<MockV3AggregatorFactory>
    let aggregators: Array<string>
    let thresholds: Array<number>
    let decimals = 8
    let initialAnswer = 10000000000
    beforeEach(async () => {
      agg1 = await aggregatorFactory
        .connect(personas.Carol)
        .deploy(decimals, initialAnswer)
      agg2 = await aggregatorFactory
        .connect(personas.Carol)
        .deploy(decimals, initialAnswer)
      aggregators = [agg1.address, agg2.address]
      thresholds = [flaggingThreshold1, flaggingThreshold2]
      await validator.setThresholds(aggregators, thresholds)
    })

    describe('when neither are stale', () => {
      it('returns false', async () => {
        assert.equal(await validator.check(aggregators), false)
      })
    })

    describe('when threshold is not set in the validator', () => {
      it('returns false', async () => {
        let agg3 = await aggregatorFactory.connect(personas.Carol).deploy(decimals, initialAnswer)
        assert.equal(await validator.check([agg3.address]), false)
      })
    })

    describe('when one of the aggregators is stale', () => {
      it('returns true', async () => {
        const currentTimestamp = await agg1.latestTimestamp()
        const staleTimestamp = currentTimestamp.sub(h.bigNum(flaggingThreshold1+1))
        await agg1.updateRoundData(
          99, initialAnswer, staleTimestamp, staleTimestamp
        )
        assert.equal(await validator.check(aggregators), true)
      })
    })
  })

  describe('#update', () => {
    // both not stale (no flag)
    // one without config (no flag)
    // 1/2 stale (1 flag)
    // 2/2 stale (2 flags)
  })
})