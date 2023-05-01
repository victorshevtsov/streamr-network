import assert from 'assert'

import ControlMessage from '../../../../src/protocol/control_layer/ControlMessage'
import UnsupportedTypeError from '../../../../src/errors/UnsupportedTypeError'
import UnsupportedVersionError from '../../../../src/errors/UnsupportedVersionError'
import ValidationError from '../../../../src/errors/ValidationError'
import { Serializer } from '../../../../src/Serializer'

const VERSION = 123
const TYPE = 0
const REQUEST_ID = 'requestId'

class TestControlMessage extends ControlMessage {}

const msg = () => {
    return new TestControlMessage(VERSION, TYPE, REQUEST_ID)
}

describe('ControlMessage', () => {
    let serializer: Serializer<ControlMessage>

    beforeEach(() => {
        serializer = {
            fromArray: jest.fn(),
            toArray: jest.fn(),
        }
        ControlMessage.registerSerializer(VERSION, TYPE, serializer)
    })

    afterEach(() => {
        ControlMessage.unregisterSerializer(VERSION, TYPE)
    })

    describe('constructor', () => {
        it('is abstract', () => {
            assert.throws(() => new ControlMessage(VERSION, TYPE, REQUEST_ID), TypeError)
        })
        it('validates version', () => {
            assert.throws(() => new TestControlMessage('invalid' as any, TYPE, REQUEST_ID), ValidationError)
        })
        it('validates type', () => {
            assert.throws(() => new TestControlMessage(VERSION, 'invalid' as any, REQUEST_ID), ValidationError)
        })
        it('does not validate requestId on version < 2', () => {
            assert.doesNotThrow(() => new TestControlMessage(1, TYPE, null as any))
        })
        it('validates requestId on version >= 2', () => {
            assert.throws(() => new TestControlMessage(2, TYPE, null as any), ValidationError)
        })
    })

    describe('registerSerializer', () => {
        beforeEach(() => {
            // Start from a clean slate
            ControlMessage.unregisterSerializer(VERSION, TYPE)
        })

        it('registers a Serializer retrievable by getSerializer()', () => {
            ControlMessage.registerSerializer(VERSION, TYPE, serializer)
            assert.strictEqual(ControlMessage.getSerializer(VERSION, TYPE), serializer)
        })
        it('throws if the Serializer for a [version, type] is already registered', () => {
            ControlMessage.registerSerializer(VERSION, TYPE, serializer)
            assert.throws(() => ControlMessage.registerSerializer(VERSION, TYPE, serializer))
        })
        it('throws if the Serializer does not implement fromArray', () => {
            const invalidSerializer: any = {
                toArray: jest.fn()
            }
            assert.throws(() => ControlMessage.registerSerializer(VERSION, TYPE, invalidSerializer))
        })
        it('throws if the Serializer does not implement toArray', () => {
            const invalidSerializer: any = {
                fromArray: jest.fn()
            }
            assert.throws(() => ControlMessage.registerSerializer(VERSION, TYPE, invalidSerializer))
        })
    })

    describe('serialize', () => {
        it('calls toArray() on the configured serializer and stringifies it', () => {
            const m = msg()
            serializer.toArray = jest.fn().mockReturnValue([12345])
            assert.strictEqual(m.serialize(), '[12345]')
            expect(serializer.toArray).toBeCalledWith(m)
        })

        it('should throw on unsupported version', () => {
            const m = new TestControlMessage(999, TYPE, REQUEST_ID)
            assert.throws(() => m.serialize(), (err: UnsupportedVersionError) => {
                assert(err instanceof UnsupportedVersionError)
                assert.strictEqual(err.version, 999)
                return true
            })
        })

        it('should throw on unsupported type', () => {
            const m = new TestControlMessage(VERSION, 999, REQUEST_ID)
            assert.throws(() => m.serialize(), (err: UnsupportedTypeError) => {
                assert(err instanceof UnsupportedTypeError)
                assert.strictEqual(err.type, 999)
                return true
            })
        })
    })

    describe('deserialize', () => {
        it('parses the input, reads version and type, and calls fromArray() on the configured serializer', () => {
            const arr = [VERSION, TYPE]
            const m = msg()
            serializer.fromArray = jest.fn().mockReturnValue(m)
            assert.strictEqual(ControlMessage.deserialize(JSON.stringify(arr)), m)
            expect(serializer.fromArray).toBeCalledWith(arr)
        })

        it('should throw on unsupported version', () => {
            const arr = [999, TYPE]
            assert.throws(() => ControlMessage.deserialize(JSON.stringify(arr)), (err: UnsupportedVersionError) => {
                assert(err instanceof UnsupportedVersionError)
                assert.strictEqual(err.version, 999)
                return true
            })
        })

        it('should throw on unsupported type', () => {
            const arr = [VERSION, 999]
            assert.throws(() => ControlMessage.deserialize(JSON.stringify(arr)), (err: UnsupportedTypeError) => {
                assert(err instanceof UnsupportedTypeError)
                assert.strictEqual(err.type, 999)
                return true
            })
        })
    })

    describe('getSupportedVersions', () => {
        it('returns an array of registered versions', () => {
            assert.deepStrictEqual(ControlMessage.getSupportedVersions(), [VERSION])
        })
    })
})
