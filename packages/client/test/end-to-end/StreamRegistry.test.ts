import { Wallet } from '@ethersproject/wallet'
import { createTestStream, createRelativeTestStreamId } from '../test-utils/utils'
import { until } from '../../src/utils/promises'
import { NotFoundError } from '../../src/HttpUtil'
import { StreamrClient } from '../../src/StreamrClient'
import { Stream } from '../../src/Stream'
import { CONFIG_TEST } from '../../src/ConfigTest'
import { toStreamID } from '@streamr/protocol'
import { collect } from '../../src/utils/iterators'
import { fetchPrivateKeyWithGas, randomEthereumAddress } from '@streamr/test-utils'
import { EthereumAddress, toEthereumAddress, waitForCondition } from '@streamr/utils'

jest.setTimeout(20000)
const PARTITION_COUNT = 3

const TIMEOUT_CONFIG = {
    // eslint-disable-next-line no-underscore-dangle
    ...CONFIG_TEST._timeouts!,
    ensStreamCreation: {
        timeout: 5000,
        retryInterval: 200
    }
}

/**
 * These tests should be run in sequential order!
 */
describe('StreamRegistry', () => {

    let client: StreamrClient
    let wallet: Wallet
    let publicAddress: EthereumAddress
    let createdStream: Stream

    beforeAll(async () => {
        wallet = new Wallet(await fetchPrivateKeyWithGas())
        publicAddress = toEthereumAddress(wallet.address)
        client = new StreamrClient({
            ...CONFIG_TEST,
            auth: {
                privateKey: wallet.privateKey,
            },
            _timeouts: TIMEOUT_CONFIG
        })
    })

    beforeAll(async () => {
        createdStream = await createTestStream(client, module, {
            partitions: PARTITION_COUNT
        })
    })

    describe('createStream', () => {
        it('creates a stream with correct values', async () => {
            const path = createRelativeTestStreamId(module)
            const stream = await client.createStream({
                id: path
            })
            expect(stream.id).toBe(toStreamID(path, await client.getAddress()))
        })

        it('valid id', async () => {
            const newId = `${publicAddress}/StreamRegistry-createStream-newId-${Date.now()}`
            const newStream = await client.createStream({
                id: newId,
            })
            expect(newStream.id).toEqual(newId)
            expect(await client.getStream(newId)).toBeDefined()
        })

        it('valid path', async () => {
            const newPath = `/StreamRegistry-createStream-newPath-${Date.now()}`
            const expectedId = `${publicAddress}${newPath}`
            const newStream = await client.createStream({
                id: newPath,
            })
            expect(newStream.id).toEqual(expectedId)
            expect(await client.getStream(expectedId)).toBeDefined()
        })

        it('legacy format', async () => {
            const streamId = '7wa7APtlTq6EC5iTCBy6dw'
            await expect(async () => client.createStream({ id: streamId })).rejects.toThrow(`stream id "${streamId}" not valid`)
        })

        it('listener', async () => {
            const onCreateSteam = jest.fn()
            client.on('createStream', onCreateSteam)
            const invalidStream = await client.createStream({
                id: createRelativeTestStreamId(module, 'invalid'),
                partitions: 150
            })
            const validStream = await client.createStream({
                id: createRelativeTestStreamId(module, 'valid'),
                partitions: 3,
                description: 'Foobar'
            })
            const hasBeenCalledFor = (stream: Stream) => {
                const streamIds = onCreateSteam.mock.calls.map((c) => c[0].streamId)
                return streamIds.includes(stream.id)
            }
            await waitForCondition(() => hasBeenCalledFor(validStream))
            client.off('createStream', onCreateSteam)
            expect(onCreateSteam).toHaveBeenCalledWith({
                streamId: validStream.id,
                metadata: {
                    partitions: 3,
                    description: 'Foobar'
                },
                blockNumber: expect.any(Number)
            })
            expect(hasBeenCalledFor(invalidStream)).toBeFalse()
        })

        describe('ENS', () => {

            it('domain owned by user', async () => {
                const streamId = 'testdomain1.eth/foobar/' + Date.now()
                const ensOwnerClient = new StreamrClient({
                    ...CONFIG_TEST,
                    auth: {
                        // In dev environment the testdomain1.eth is owned by 0x4178baBE9E5148c6D5fd431cD72884B07Ad855a0.
                        // The ownership is preloaded by docker-dev-chain-init (https://github.com/streamr-dev/network-contracts)
                        privateKey: '0xe5af7834455b7239881b85be89d905d6881dcb4751063897f12be1b0dd546bdb'
                    },
                    _timeouts: TIMEOUT_CONFIG
                })
                const newStream = await ensOwnerClient.createStream({
                    id: streamId,
                })
                expect(newStream.id).toEqual(streamId)
                expect(await client.getStream(streamId)).toBeDefined()
            })

            it('domain not owned by user', async () => {
                const streamId = 'testdomain1.eth/foobar'
                await expect(async () => client.createStream({ id: streamId })).rejects.toThrow()
            })

            it('domain not registered', async () => {
                const streamId = 'some-non-registered-address.eth/foobar'
                await expect(async () => client.createStream({ id: streamId })).rejects.toThrow()
            })

        })
    })

    describe('getStream', () => {
        it('get an existing Stream', async () => {
            const stream = await createTestStream(client, module)
            const existingStream = await client.getStream(stream.id)
            expect(existingStream.id).toEqual(stream.id)
        })

        it('get a non-existing Stream', async () => {
            const streamId = `${publicAddress}/StreamRegistry-nonexisting-${Date.now()}`
            return expect(() => client.getStream(streamId)).rejects.toThrow(NotFoundError)
        })
    })

    describe('getOrCreateStream', () => {
        it('existing Stream by id', async () => {
            const existingStream = await client.getOrCreateStream({
                id: createdStream.id,
            })
            expect(existingStream.id).toBe(createdStream.id)
        })

        it('new Stream by id', async () => {
            const newId = `${publicAddress}/StreamRegistry-getOrCreate-newId-${Date.now()}`
            const newStream = await client.getOrCreateStream({
                id: newId,
            })
            expect(newStream.id).toEqual(newId)
        })

        it('new Stream by path', async () => {
            const newPath = `/StreamRegistry-getOrCreate-newPath-${Date.now()}`
            const newStream = await client.getOrCreateStream({
                id: newPath,
            })
            expect(newStream.id).toEqual(`${publicAddress}${newPath}`)

            // ensure can get after create i.e. doesn't try create again
            const sameStream = await client.getOrCreateStream({
                id: newPath,
            })
            expect(sameStream.id).toEqual(newStream.id)
        })

        it('fails if stream prefixed with other users address', async () => {
            // can't create streams for other users
            const otherAddress = randomEthereumAddress()
            const newPath = `/StreamRegistry-getOrCreate-newPath-${Date.now()}`
            // backend should error
            await expect(async () => {
                await client.getOrCreateStream({
                    id: `${otherAddress}${newPath}`,
                })
            }).rejects.toThrow(`stream id "${otherAddress}${newPath}" not in namespace of authenticated user "${publicAddress}"`)
        })
    })

    describe('getStreamPublishers', () => {
        it('retrieves a list of publishers', async () => {
            const publishers = await collect(client.getStreamPublishers(createdStream.id))
            const address = await client.getAddress()
            return expect(publishers).toEqual([address])
        })
    })

    describe('isStreamPublisher', () => {
        it('returns true for valid publishers', async () => {
            const address = await client.getAddress()
            const valid = await client.isStreamPublisher(createdStream.id, address)
            return expect(valid).toBe(true)
        })
        it('throws error for invalid address', async () => {
            return expect(() => client.isStreamPublisher(createdStream.id, 'some-invalid-address')).rejects.toThrow()
        })
        it('returns false for invalid publishers', async () => {
            const valid = await client.isStreamPublisher(createdStream.id, randomEthereumAddress())
            return expect(valid).toBe(false)
        })
    })

    describe('getStreamSubscribers', () => {
        it('retrieves a list of subscribers', async () => {
            const subscribers = await collect(client.getStreamSubscribers(createdStream.id))
            const address = await client.getAddress()
            return expect(subscribers).toEqual([address])
        })
    })

    describe('isStreamSubscriber', () => {
        it('returns true for valid subscribers', async () => {
            const address = await client.getAddress()
            const valid = await client.isStreamSubscriber(createdStream.id, address)
            return expect(valid).toBe(true)
        })
        it('throws error for invalid address', async () => {
            return expect(() => client.isStreamSubscriber(createdStream.id, 'some-invalid-address')).rejects.toThrow()
        })
        it('returns false for invalid subscribers', async () => {
            const valid = await client.isStreamSubscriber(createdStream.id, randomEthereumAddress())
            return expect(valid).toBe(false)
        })
    })

    describe('update', () => {
        it('happy path', async () => {
            await createdStream.update({
                description: `description-${Date.now()}`
            })
            await until(async () => {
                try {
                    return (await client.getStream(createdStream.id)).getMetadata().description === createdStream.getMetadata().description
                } catch (err) {
                    return false
                }
            }, 100000, 1000)
            // check that other fields not overwritten
            const updatedStream = await client.getStream(createdStream.id)
            expect(updatedStream.getMetadata().partitions).toBe(PARTITION_COUNT)
        })
    })

    describe('delete', () => {
        it('happy path', async () => {
            const props = { id: createRelativeTestStreamId(module) }
            const stream = await client.createStream(props)
            await stream.delete()
            await until(async () => {
                try {
                    await client.getStream(stream.id)
                    return false
                } catch (err: any) {
                    return err.errorCode === 'NOT_FOUND'
                }
            }, 100000, 1000)
            return expect(client.getStream(stream.id)).rejects.toThrow()
        })
    })
})
