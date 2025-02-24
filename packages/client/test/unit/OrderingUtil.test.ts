import assert from 'assert'

import { MessageID, MessageRef, StreamMessage, toStreamID } from '@streamr/protocol'
import OrderingUtil from '../../src/subscribe/ordering/OrderingUtil'
import { EthereumAddress, toEthereumAddress } from '@streamr/utils'
import { shuffle } from 'lodash'

const defaultPublisherId = toEthereumAddress('0x0000000000000000000000000000000000000001')
const publisherId1 = toEthereumAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const publisherId2 = toEthereumAddress('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
const publisherId3 = toEthereumAddress('0xcccccccccccccccccccccccccccccccccccccccc')

const createMsg = (
    timestamp = 1,
    sequenceNumber = 0,
    prevTimestamp: number | null = null,
    prevSequenceNumber = 0,
    content = {},
    publisherId = defaultPublisherId,
    msgChainId = '1',
) => {
    const prevMsgRef = prevTimestamp ? new MessageRef(prevTimestamp, prevSequenceNumber) : null
    return new StreamMessage({
        messageId: new MessageID(toStreamID('streamId'), 0, timestamp, sequenceNumber, publisherId, msgChainId),
        prevMsgRef,
        content,
        signature: 'signature'
    })
}

const msg = createMsg()

describe('OrderingUtil', () => {
    let util: OrderingUtil
    afterEach(() => {
        util.clearGaps()
    })
    it('calls the message handler when a message is received', (done) => {
        const handler = (streamMessage: StreamMessage) => {
            assert.deepStrictEqual(streamMessage.serialize(), msg.serialize())
            done()
        }
        util = new OrderingUtil(handler, () => {})
        util.add(msg)
    })
    it('calls the gap handler if a gap is detected', (done) => {
        const gapHandler = (from: MessageRef, to: MessageRef, publisherId: EthereumAddress) => {
            assert.equal(from.timestamp, 1)
            assert.equal(from.sequenceNumber, 1)
            assert.equal(to.timestamp, 3)
            assert.equal(to.sequenceNumber, 0)
            assert.equal(publisherId, defaultPublisherId)
            done()
        }
        util = new OrderingUtil( () => {}, gapHandler, 50, 50)
        const msg1 = msg
        const msg4 = createMsg(4, undefined, 3)
        util.add(msg1)
        util.add(msg4)
    })
    it('does not call gap handler if gap detected but resolved before request should be sent', (done) => {
        const gapHandler = () => {
            throw new Error('The gap handler should not be called.')
        }
        util = new OrderingUtil(() => {}, gapHandler, 5000, 5000)
        const msg1 = msg
        const msg2 = createMsg(2, undefined, 1)
        const msg3 = createMsg(3, undefined, 2)
        const msg4 = createMsg(4, undefined, 3)
        util.add(msg1)
        util.add(msg4)
        setTimeout(() => {
            util.add(msg2)
            util.add(msg3)
            done()
        }, 500)
    })
    it('handles unordered messages in order (large randomized test)', () => {
        const msg1Pub1 = createMsg(1, 0, null, 0, {}, publisherId1)
        const msg1Pub2 = createMsg(1, 0, null, 0, {}, publisherId2)
        const msg1Pub3 = createMsg(1, 0, null, 0, {}, publisherId3)
        const expected1 = [msg1Pub1]
        const expected2 = [msg1Pub2]
        const expected3 = [msg1Pub3]
        for (let i = 2; i <= 100000; i++) {
            expected1.push(createMsg(i, 0, i - 1, 0, {}, publisherId1))
        }
        for (let i = 2; i <= 100000; i++) {
            expected2.push(createMsg(i, 0, i - 1, 0, {}, publisherId2))
        }
        for (let i = 2; i <= 100000; i++) {
            expected3.push(createMsg(i, 0, i - 1, 0, {}, publisherId3))
        }
        const shuffled = shuffle(expected1.concat(expected2).concat(expected3))
        const received1: StreamMessage[] = []
        const received2: StreamMessage[] = []
        const received3: StreamMessage[] = []
        util = new OrderingUtil((m) => {
            if (m.getPublisherId() === publisherId1) {
                received1.push(m)
            } else if (m.getPublisherId() === publisherId2) {
                received2.push(m)
            } else if (m.getPublisherId() === publisherId3) {
                received3.push(m)
            }
        }, () => {}, 50)
        util.add(msg1Pub1)
        util.add(msg1Pub2)
        util.add(msg1Pub3)
        shuffled.forEach((m) => {
            if (m.getTimestamp() !== 1) {
                util.add(m)
            }
        })
        try {
            assert.deepStrictEqual(received1, expected1)
            assert.deepStrictEqual(received2, expected2)
            assert.deepStrictEqual(received3, expected3)
        } catch (e) {
            const shuffledTimestamps: number[] = []
            shuffled.forEach((streamMessage: StreamMessage) => {
                shuffledTimestamps.push(streamMessage.getTimestamp())
            })
            const receivedTimestamps1: number[] = []
            received1.forEach((streamMessage: StreamMessage) => {
                receivedTimestamps1.push(streamMessage.getTimestamp())
            })
            const receivedTimestamps2: number[] = []
            received2.forEach((streamMessage: StreamMessage) => {
                receivedTimestamps2.push(streamMessage.getTimestamp())
            })
            const receivedTimestamps3: number[] = []
            received3.forEach((streamMessage: StreamMessage) => {
                receivedTimestamps3.push(streamMessage.getTimestamp())
            })
            throw new Error('Was expecting to receive messages ordered per timestamp but instead received timestamps in this order:\n'
                + `publisher 1: ${receivedTimestamps1}\n`
                + `publisher 2: ${receivedTimestamps2}\n`
                + `publisher 3: ${receivedTimestamps3}\n`
                + `The unordered messages were processed in the following timestamp order:\n${shuffledTimestamps}`)
        }
    })
})
