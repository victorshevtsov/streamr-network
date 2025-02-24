import 'reflect-metadata'

import { fastPrivateKey } from '@streamr/test-utils'
import { Message, MessageMetadata } from '../../src/Message'
import { StreamPermission } from '../../src/permission'
import { Stream } from '../../src/Stream'
import { StreamrClient } from '../../src/StreamrClient'
import { counterId } from '../../src/utils/utils'
import { addAfterFn } from '../test-utils/jest-utils'
import { getPublishTestStreamMessages } from '../test-utils/publish'
import {
    createTestStream,
    uid
} from '../test-utils/utils'
import { FakeEnvironment } from './../test-utils/fake/FakeEnvironment'
import { waitForCondition } from '@streamr/utils'

// this number should be at least 10, otherwise late subscribers might not join
// in time to see any realtime messages
const MAX_MESSAGES = 10

const waitMessagesReceived = async (
    received: Record<string, MessageMetadata[]>,
    published: Record<string, MessageMetadata[]>
) => {
    await waitForCondition(() => {
        const receivedCount = Object.values(received).flat().length
        const publishedCount = Object.values(published).flat().length
        return receivedCount === publishedCount
    }, 10 * 1000)
}

describe('PubSub with multiple clients', () => {
    let stream: Stream
    let mainClient: StreamrClient
    let otherClient: StreamrClient
    let privateKey: string
    let environment: FakeEnvironment
    const addAfter = addAfterFn()

    beforeEach(async () => {
        environment = new FakeEnvironment()
        privateKey = fastPrivateKey()
        mainClient = environment.createClient({
            id: 'subscriber-main',
            auth: {
                privateKey
            }
        })
        stream = await createTestStream(mainClient, module)
        const storageNode = environment.startStorageNode()
        await stream.addToStorageNode(storageNode.id)
    })

    afterEach(async () => {
        await environment.destroy()
    })

    async function createPublisher(id: number) {
        const pubClient = environment.createClient({
            id: `publisher${id}`
        })
        const publisherId = await pubClient.getAddress()

        addAfter(async () => {
            counterId.clear(publisherId) // prevent overflows in counter
        })

        const pubUser = await pubClient.getAddress()
        await stream.grantPermissions({
            permissions: [StreamPermission.PUBLISH, StreamPermission.SUBSCRIBE],
            user: pubUser
        })
        return pubClient
    }

    async function createSubscriber() {
        const client = environment.createClient({
            id: 'subscriber-other',
            auth: {
                privateKey
            }
        })
        const user = await client.getAddress()
        await stream.grantPermissions({ permissions: [StreamPermission.SUBSCRIBE], user })
        return client
    }

    function checkMessages(published: Record<string, Message[]>, received: Record<string, MessageMetadata[]>) {
        for (const [key, msgs] of Object.entries(published)) {
            expect(received[key].map((m) => m.signature)).toEqual(msgs.map((m) => m.signature))
        }
    }

    describe('can get messages published from other client', () => {
        test('it works', async () => {
            otherClient = await createSubscriber()

            const receivedMessagesOther: any[] = []
            const receivedMessagesMain: any[] = []
            // subscribe to stream from other client instance
            await otherClient.subscribe({
                stream: stream.id,
            }, (msg) => {
                receivedMessagesOther.push(msg)
            })
            // subscribe to stream from main client instance
            await mainClient.subscribe({
                stream: stream.id,
            }, (msg) => {
                receivedMessagesMain.push(msg)
            })
            const message = {
                msg: uid('message'),
            }
            // publish message on main client
            await mainClient.publish(stream, message)
            await waitForCondition(() => receivedMessagesMain.length === 1 && receivedMessagesOther.length === 1)
            // messages should arrive on both clients?
            expect(receivedMessagesMain).toEqual([message])
            expect(receivedMessagesOther).toEqual([message])
        })
    })

    describe('multiple publishers', () => {
        test('works with multiple publishers on a single stream', async () => {
            // this creates two subscriber clients and multiple publisher clients
            // all subscribing and publishing to same stream

            otherClient = await createSubscriber()

            const receivedMessagesOther: Record<string, MessageMetadata[]> = {}
            const receivedMessagesMain: Record<string, MessageMetadata[]> = {}
            // subscribe to stream from other client instance
            await otherClient.subscribe({
                stream: stream.id,
            }, (_content, metadata) => {
                const msgs = receivedMessagesOther[metadata.publisherId] || []
                msgs.push(metadata)
                receivedMessagesOther[metadata.publisherId] = msgs
            })

            // subscribe to stream from main client instance
            await mainClient.subscribe({
                stream: stream.id,
            }, (_content, metadata) => {
                const msgs = receivedMessagesMain[metadata.publisherId] || []
                msgs.push(metadata)
                receivedMessagesMain[metadata.publisherId] = msgs
            })

            const publishers: StreamrClient[] = []
            for (let i = 0; i < 3; i++) {
                publishers.push(await createPublisher(i))
            }
            const published: Record<string, Message[]> = {}
            await Promise.all(publishers.map(async (pubClient) => {
                const publisherId = await pubClient.getAddress()
                addAfter(() => {
                    counterId.clear(publisherId) // prevent overflows in counter
                })
                const publishTestMessages = getPublishTestStreamMessages(pubClient, stream, {
                    createMessage: ({ batchId }) => ({
                        batchId,
                        value: counterId(publisherId),
                    })
                })
                published[publisherId] = await publishTestMessages(MAX_MESSAGES)
            }))

            await waitMessagesReceived(receivedMessagesMain, published)
            await waitMessagesReceived(receivedMessagesOther, published)

            checkMessages(published, receivedMessagesMain)
            checkMessages(published, receivedMessagesOther)
        }, 10 * 1000)

        // late subscriber test is super unreliable. Doesn't seem to be a good way to make the
        // late subscriber reliably get all of both realtime and resent messages
        test.skip('works with multiple publishers on one stream with late subscriber (resend)', async () => {
            // this creates two subscriber clients and multiple publisher clients
            // all subscribing and publishing to same stream
            // the otherClient subscribes after the 3rd message hits storage
            otherClient = await createSubscriber()

            const receivedMessagesOther: Record<string, MessageMetadata[]> = {}
            const receivedMessagesMain: Record<string, MessageMetadata[]> = {}

            // subscribe to stream from main client instance
            const mainSub = await mainClient.subscribe({
                stream: stream.id,
            }, (_content, metadata) => {
                const key = metadata.publisherId
                const msgs = receivedMessagesMain[key] || []
                msgs.push(metadata)
                receivedMessagesMain[key] = msgs
                if (Object.values(receivedMessagesMain).every((m) => m.length === MAX_MESSAGES)) {
                    mainSub.unsubscribe()
                }
            })

            /* eslint-disable no-await-in-loop */
            const publishers: StreamrClient[] = []
            for (let i = 0; i < 3; i++) {
                publishers.push(await createPublisher(i))
            }

            /* eslint-enable no-await-in-loop */
            let counter = 0
            const published: Record<string, Message[]> = {}
            await Promise.all(publishers.map(async (pubClient) => {
                const publisherId = await pubClient.getAddress()
                addAfter(() => {
                    counterId.clear(publisherId) // prevent overflows in counter
                })

                const publishTestMessages = getPublishTestStreamMessages(pubClient, stream, {
                    waitForLast: true,
                    waitForLastTimeout: 35000,
                    waitForLastCount: MAX_MESSAGES * publishers.length,
                    delay: 500 + Math.random() * 1000,
                    createMessage: (msg) => ({
                        ...msg,
                        publisherId,
                    }),
                })

                async function addLateSubscriber(lastMessage: Message) {
                    // late subscribe to stream from other client instance
                    const lateSub = await otherClient.subscribe({
                        stream: stream.id,
                        resend: {
                            from: lastMessage.streamMessage.getMessageRef()
                        }
                    }, (_content, metadata) => {
                        const key = metadata.publisherId
                        const msgs = receivedMessagesOther[key] || []
                        msgs.push(metadata)
                        receivedMessagesOther[key] = msgs
                    })

                    addAfter(async () => {
                        await lateSub.unsubscribe()
                    })
                }

                let firstMessage: Message
                const msgs = await publishTestMessages(1, {
                    async afterEach(streamMessage) {
                        firstMessage = streamMessage
                    }
                }) // ensure first message stored
                published[publisherId] = msgs.concat(await publishTestMessages(MAX_MESSAGES - 1, {
                    waitForLast: true,
                    async afterEach() {
                        counter += 1
                        if (counter === 3) {
                            await addLateSubscriber(firstMessage)
                        }
                    }
                }))
            }))

            await waitMessagesReceived(receivedMessagesMain, published)
            await waitMessagesReceived(receivedMessagesOther, published)

            checkMessages(published, receivedMessagesMain)
            checkMessages(published, receivedMessagesOther)

            await otherClient.destroy()
            await Promise.all(publishers.map((p) => p.destroy()))
        })
    })

    test('works with multiple publishers on one stream', async () => {
        otherClient = await createSubscriber()
        await stream.grantPermissions({ permissions: [StreamPermission.SUBSCRIBE], public: true })

        const receivedMessagesOther: Record<string, MessageMetadata[]> = {}
        const receivedMessagesMain: Record<string, MessageMetadata[]> = {}
        // subscribe to stream from other client instance
        await otherClient.subscribe({
            stream: stream.id,
        }, (_content, metadata) => {
            const key = metadata.publisherId
            const msgs = receivedMessagesOther[key] || []
            msgs.push(metadata)
            receivedMessagesOther[key] = msgs
        })

        // subscribe to stream from main client instance
        await mainClient.subscribe({
            stream: stream.id,
        }, (_content, metadata) => {
            const key = metadata.publisherId
            const msgs = receivedMessagesMain[key] || []
            msgs.push(metadata)
            receivedMessagesMain[key] = msgs
        })

        const publishers: StreamrClient[] = []
        for (let i = 0; i < 1; i++) {
            publishers.push(await createPublisher(i))
        }

        const published: Record<string, Message[]> = {}
        await Promise.all(publishers.map(async (pubClient) => {
            const publisherId = await pubClient.getAddress()
            const publishTestMessages = getPublishTestStreamMessages(pubClient, stream, {
                waitForLast: true,
                waitForLastTimeout: 35000,
            })
            await publishTestMessages(MAX_MESSAGES, {
                afterEach(msg) {
                    published[publisherId] = published[publisherId] || []
                    published[publisherId].push(msg)
                }
            })
        }))

        await waitMessagesReceived(receivedMessagesMain, published)
        await waitMessagesReceived(receivedMessagesOther, published)

        checkMessages(published, receivedMessagesMain)
        checkMessages(published, receivedMessagesOther)

        await Promise.all(publishers.map((p) => p.destroy()))
    })

    // late subscriber test is super unreliable. Doesn't seem to be a good way to make the
    // late subscriber reliably get all of both realtime and resent messages
    test.skip('works with multiple publishers on one stream with late subscriber (resend)', async () => {
        const published: Record<string, Message[]> = {}

        otherClient = environment.createClient()
        const otherUser = await otherClient.getAddress()

        await stream.grantPermissions({ permissions: [StreamPermission.SUBSCRIBE], user: otherUser })

        const receivedMessagesOther: Record<string, MessageMetadata[]> = {}
        const receivedMessagesMain: Record<string, MessageMetadata[]> = {}

        // subscribe to stream from main client instance
        const mainSub = await mainClient.subscribe({
            stream: stream.id,
        }, (_content, metadata) => {
            const key = metadata.publisherId
            const msgs = receivedMessagesMain[key] || []
            msgs.push(metadata)
            receivedMessagesMain[key] = msgs
            if (Object.values(receivedMessagesMain).every((m) => m.length === MAX_MESSAGES)) {
                mainSub.unsubscribe()
            }
        })

        const publishers: StreamrClient[] = []
        for (let i = 0; i < 3; i++) {
            publishers.push(await createPublisher(i))
        }

        let counter = 0
        await Promise.all(publishers.map(async (pubClient) => {
            const publisherId = await pubClient.getAddress()
            const publishTestMessages = getPublishTestStreamMessages(pubClient, stream, {
                waitForLast: true,
                waitForLastTimeout: 35000,
                waitForLastCount: MAX_MESSAGES * publishers.length,
                delay: 500 + Math.random() * 1000,
            })

            async function addLateSubscriber(lastMessage: Message) {
                // late subscribe to stream from other client instance
                const lateSub = await otherClient.subscribe({
                    stream: stream.id,
                    resend: {
                        from: lastMessage.streamMessage.getMessageRef()
                    }
                }, (_content, metadata) => {
                    const key = metadata.publisherId
                    const msgs = receivedMessagesOther[key] || []
                    msgs.push(metadata)
                    receivedMessagesOther[key] = msgs
                })

                addAfter(async () => {
                    await lateSub.unsubscribe()
                })
            }

            let firstMessage: Message
            const msgs = await publishTestMessages(1, {
                async afterEach(streamMessage) {
                    firstMessage = streamMessage
                }
            }) // ensure first message stored
            published[publisherId] = msgs.concat(await publishTestMessages(MAX_MESSAGES - 1, {
                async afterEach() {
                    counter += 1
                    if (counter === 3) {
                        // late subscribe to stream from other client instance
                        await addLateSubscriber(firstMessage)
                    }
                }
            }))
        }))

        await waitMessagesReceived(receivedMessagesMain, published)
        await waitMessagesReceived(receivedMessagesOther, published)

        checkMessages(published, receivedMessagesMain)
        checkMessages(published, receivedMessagesOther)

        await Promise.all(publishers.map((p) => p.destroy()))
    })
})
