import { NodeJSSerialConnection, Constants, Packet } from "@liamcottle/meshcore.js";

function contactPrefixKey(publicKey) {
    return Buffer.from(publicKey).subarray(0, 6).toString("hex");
}

function createMentionRegex(displayName) {
    const escapedDisplayName = displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`@\\[${escapedDisplayName}\\]`, "i");
}

function parseContactInfo(text) {
    const match = text.match(/<([0-9a-f]{64}):(\d+):([^>]*)>/i);
    if (!match) {
        return null;
    }

    return {
        publicKey: Buffer.from(match[1], "hex"),
        type: Number(match[2]),
        name: match[3],
    };
}

function formatContactInfo(info) {
    return `<${Buffer.from(info.publicKey).toString("hex")}:${info.type}:${info.name}>`;
}

async function addContact(connection, contactInfo) {
    await connection.addOrUpdateContact(
        contactInfo.publicKey,
        contactInfo.type,
        0,
        0,
        new Uint8Array(64),
        contactInfo.name,
        0,
        0,
        0,
    );
}

// Resolves with the request timestamp, to be used as `since` on the next call
function requestContacts(connection, since = null) {
    return new Promise((resolve, reject) => {
        const requestedAt = Math.floor(Date.now() / 1000);
        const onComplete = () => {
            connection.off(Constants.ResponseCodes.EndOfContacts, onComplete);
            connection.off(Constants.ResponseCodes.Err, onError);
            resolve(requestedAt);
        };
        const onError = (error) => {
            connection.off(Constants.ResponseCodes.EndOfContacts, onComplete);
            connection.off(Constants.ResponseCodes.Err, onError);
            reject(error);
        };

        connection.once(Constants.ResponseCodes.EndOfContacts, onComplete);
        connection.once(Constants.ResponseCodes.Err, onError);

        connection.sendCommandGetContacts(since).catch(onError);
    });
}

async function refreshContacts(state) {
    state.contactRefreshQueue = state.contactRefreshQueue
        .then(async () => {
            state.lastContactRequestAt = await requestContacts(state.connection, state.lastContactRequestAt);
        })
        .catch((error) => console.error("MeshCore contact refresh failed", error));

    await state.contactRefreshQueue;
}

async function handleChannelMessage(state, message) {
    const senderMatch = message.text.match(/^([^:]+):\s*/);
    const senderName = senderMatch ? senderMatch[1] : null;

    // Check for contact info in the message text
    const contactInfo = parseContactInfo(message.text);
    if (contactInfo) {
        // If we don't know the contact, add them to our contacts list
        const contactKey = contactPrefixKey(contactInfo.publicKey);
        if (!state.contactNamesByPrefix.has(contactKey)) {
            await addContact(state.connection, contactInfo);
        }

        // If we have our companion info, send it back as a response
        if (state.companionInfo) {
            await state.connection.sendChannelTextMessage(message.channelIdx, formatContactInfo(state.companionInfo));
        }

        console.log(`[meshcore] [channel] [contact] ${message.text}`);
        return;
    }

    const mentionMatch = state.mentionRegex?.exec(message.text);
    if (!mentionMatch) {
        // If it's not a contact and not a mention, ignore it for now
        console.log(`[meshcore] [channel] [message] ${message.text}`);
        return;
    }

    const text = message.text.slice(mentionMatch.index + mentionMatch[0].length).trim();
    if (text) {
        console.log(`[meshcore] [channel] [mention] ${senderName ?? "unknown"}: ${text}`);

        const item = { source: "meshcore", from: senderName, text, timestamp: message.senderTimestamp };
        await state.onItemReceived(item);
    }
}

async function handleContactMessage(state, message) {
    const contactName = state.contactNamesByPrefix.get(contactPrefixKey(message.pubKeyPrefix));
    if (!contactName) {
        console.warn("Received direct message from unknown MeshCore contact");
    }

    const senderId = Buffer.from(message.pubKeyPrefix).subarray(0, 3).toString("hex").toUpperCase();
    const senderName = `${senderId} \u00b7 ${contactName ?? "Unknown"}`;
    console.log(`[meshcore] [direct] [message] ${senderName}: ${message.text}`);

    const item = { source: "meshcore", from: senderName, text: message.text, timestamp: message.senderTimestamp };
    await state.onItemReceived(item);
}

async function handleWaitingMessage(state, message) {
    if (message.channelMessage) {
        await handleChannelMessage(state, message.channelMessage);
    } else if (message.contactMessage) {
        await handleContactMessage(state, message.contactMessage);
    }
}

async function fetchWaitingMessages(state) {
    state.messageHandlingQueue = state.messageHandlingQueue
        .then(async () => {
            const waitingMessages = await state.connection.getWaitingMessages();
            for (const message of waitingMessages) {
                await handleWaitingMessage(state, message);
            }
        })
        .catch((error) => console.error("MeshCore message handling failed", error));

    await state.messageHandlingQueue;
}

export async function startMeshCore({ onItemReceived } = {}) {
    if (!process.env.MESHCORE_SERIAL_PATH) {
        console.warn("[meshcore] MESHCORE_SERIAL_PATH not set; skipping MeshCore startup.");
        return null;
    }

    const connection = new NodeJSSerialConnection(process.env.MESHCORE_SERIAL_PATH);

    const state = {
        connection,
        onItemReceived,
        companionInfo: null,
        mentionRegex: null,
        contactNamesByPrefix: new Map(),
        lastContactRequestAt: null,
        contactRefreshQueue: Promise.resolve(),
        messageHandlingQueue: Promise.resolve(),
    };

    connection.on("connected", async () => {
        state.companionInfo = await connection.getSelfInfo();
        state.mentionRegex = createMentionRegex(state.companionInfo.name);

        try {
            await connection.syncDeviceTime();
        } catch (error) {
            console.warn("[meshcore] Device time sync failed");
        }

        await refreshContacts(state);

        console.log(`[meshcore] Connected as '${state.companionInfo.name}' with ${state.contactNamesByPrefix.size} known contacts`);

        await fetchWaitingMessages(state);
    });

    connection.on(Constants.PushCodes.MsgWaiting, async () => {
        // Request new messages as they arrive
        await fetchWaitingMessages(state);
    });

    connection.on(Constants.PushCodes.Advert, async () => {
        // Update contacts when a new one is added
        await refreshContacts(state);
    });

    connection.on(Constants.ResponseCodes.Contact, (contact) => {
        state.contactNamesByPrefix.set(contactPrefixKey(contact.publicKey), contact.advName);
    });

    if (process.env.MESHCORE_LOG_RX_DATA === "true") {
        connection.on(Constants.PushCodes.LogRxData, async ({ lastSnr, lastRssi, raw }) => {
            const packet = Packet.fromBytes(raw);
            console.log(`[meshcore] [rx] SNR ${lastSnr}, RSSI ${lastRssi}:`, packet);
        });
    }

    await state.connection.connect();
}
