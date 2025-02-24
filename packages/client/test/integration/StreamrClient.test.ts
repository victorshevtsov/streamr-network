import 'reflect-metadata'

import { Defer, wait } from '@streamr/utils'
import fs from 'fs'
import path from 'path'
import { StreamPartID, StreamPartIDUtils } from '@streamr/protocol'
import { fastPrivateKey, fastWallet } from '@streamr/test-utils'
import { StreamPermission } from '../../src/permission'
import { StreamrClient } from '../../src/StreamrClient'
import { FakeEnvironment } from '../test-utils/fake/FakeEnvironment'
import {
    getPublishTestStreamMessages, Msg
} from '../test-utils/publish'
import { createTestStream } from '../test-utils/utils'
import { collect } from '../../src/utils/iterators'
import { MessageMetadata } from '../../src/Message'

// TODO rename this test to something more specific (and maybe divide to multiple test files?)

const MAX_MESSAGES = 10
const TIMEOUT = 30 * 1000
const WAIT_TIME = 600

describe('StreamrClient', () => {
    let client: StreamrClient
    let publishTestMessages: ReturnType<typeof getPublishTestStreamMessages>
    let streamDefinition: StreamPartID
    let privateKey: string
    let environment: FakeEnvironment

    beforeEach(async () => {
        privateKey = fastPrivateKey()
        environment = new FakeEnvironment()
        client = environment.createClient({
            auth: {
                privateKey
            }
        })
        const stream = await createTestStream(client, module)
        streamDefinition = stream.getStreamParts()[0]
        const publisherWallet = fastWallet()
        await stream.grantPermissions({
            user: publisherWallet.address,
            permissions: [StreamPermission.PUBLISH]
        })
        publishTestMessages = getPublishTestStreamMessages(environment.createClient({
            auth: {
                privateKey: publisherWallet.privateKey
            }
        }), streamDefinition)
    })

    describe('Pub/Sub', () => {
        it('client.publish does not error', async () => {
            await client.publish(streamDefinition, {
                test: 'client.publish',
            })
            await wait(WAIT_TIME)
        }, TIMEOUT)

        it('Stream.publish does not error', async () => {
            const stream = await client.getStream(StreamPartIDUtils.getStreamID(streamDefinition))
            await stream.publish({
                test: 'Stream.publish',
            })
            await wait(WAIT_TIME)
        }, TIMEOUT)

        it('client.publish with Stream object as arg', async () => {
            const stream = await client.getStream(StreamPartIDUtils.getStreamID(streamDefinition))
            await client.publish(stream, {
                test: 'client.publish.Stream.object',
            })
            await wait(WAIT_TIME)
        }, TIMEOUT)

        it('client.subscribe (realtime) with onMessage signal', async () => {
            const done = new Defer<void>()
            const msg = Msg()

            const sub = await client.subscribe(streamDefinition)

            sub.onMessage.listen(done.wrap(async (streamMessage) => {
                sub.unsubscribe()
                const parsedContent = streamMessage.getParsedContent()
                expect(parsedContent).toEqual(msg)
                expect(streamMessage.getPublisherId()).toBeTruthy()
                expect(streamMessage.signature).toBeTruthy()
            }))

            // Publish after subscribed
            await client.publish(streamDefinition, msg)
            await sub.consume()
            await done
        })

        it('client.subscribe (realtime) with onMessage callback', async () => {
            const done = new Defer<void>()
            const mockMessage = Msg()
            await client.subscribe(streamDefinition, done.wrap(async (content, metadata) => {
                expect(content).toEqual(mockMessage)
                expect(metadata.publisherId).toBeTruthy()
                expect(metadata.signature).toBeTruthy()
            }))

            // Publish after subscribed
            await client.publish(streamDefinition, mockMessage)
            await done
        })

        it('client.subscribe with onMessage & collect', async () => {
            const onMessageMsgs: MessageMetadata[] = []
            const done = new Defer<undefined>()
            const sub = await client.subscribe(streamDefinition, async (_content, metadata) => {
                onMessageMsgs.push(metadata)
                if (onMessageMsgs.length === MAX_MESSAGES) {
                    done.resolve(undefined)
                }
            })

            const published = await publishTestMessages(MAX_MESSAGES)
            await expect(async () => collect(sub, 1)).rejects.toThrow()
            await done
            expect(onMessageMsgs.map(((m) => m.signature))).toEqual(published.map(((m) => m.signature)))
        })

        it('client.subscribe with onMessage callback that throws', async () => {
            const onMessageMsgs: MessageMetadata[] = []
            const err = new Error('expected error')
            const sub = await client.subscribe(streamDefinition, async (_content, metadata) => {
                onMessageMsgs.push(metadata)
                if (onMessageMsgs.length === MAX_MESSAGES) {
                    sub.return()
                }
                throw err
            })

            const onSubError = jest.fn()
            sub.onError.listen(onSubError)

            const published = await publishTestMessages(MAX_MESSAGES)
            await sub.onFinally.listen()
            expect(onMessageMsgs.map(((m) => m.signature))).toEqual(published.slice(0, 1).map(((m) => m.signature)))
            expect(onSubError).toHaveBeenCalledTimes(1)
            expect(onSubError).toHaveBeenCalledWith(err)
        })

        it('publish and subscribe a sequence of messages', async () => {
            const done = new Defer<unknown>()
            const received: MessageMetadata[] = []
            const sub = await client.subscribe(streamDefinition, (_content, metadata) => {
                received.push(metadata)
                expect(metadata.publisherId).toBeTruthy()
                expect(metadata.signature).toBeTruthy()
                if (received.length === MAX_MESSAGES) {
                    done.resolve(client.unsubscribe(sub))
                }
            })

            // Publish after subscribed
            const published = await publishTestMessages(MAX_MESSAGES)

            await done
            expect(received.map((m) => m.signature)).toEqual(published.map(((m) => m.signature)))
        })
    })

    describe('utf-8 encoding', () => {
        it('decodes realtime messages correctly', async () => {
            const publishedMessage = Msg({
                content: fs.readFileSync(path.join(__dirname, '../data/utf8Example.txt'), 'utf8')
            })
            const sub = await client.subscribe(streamDefinition)
            await client.publish(streamDefinition, publishedMessage)
            const messages = await collect(sub, 1)
            expect(messages.map((s) => s.content)).toEqual([publishedMessage])
        })
    })
})
