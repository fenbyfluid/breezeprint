import { NodeJSSerialConnection, Constants, Packet } from "@liamcottle/meshcore.js";

if (!process.env.MESHCORE_SERIAL_PATH) {
    throw new Error("MESHCORE_SERIAL_PATH is required");
}

const connection = new NodeJSSerialConnection(process.env.MESHCORE_SERIAL_PATH);

const logRxData = process.env.MESHCORE_LOG_RX_DATA === "true";

let mentionRegex = null;
let companionInfo = null;
let messageHandlingQueue = Promise.resolve();
const contactNamesByPrefix = new Map();
let lastContactRequestAt = null;
let contactRefreshQueue = Promise.resolve();

function contactPrefixKey(publicKey) {
    return Buffer.from(publicKey).subarray(0, 6).toString("hex");
}

function requestContacts(since = null) {
    return new Promise((resolve, reject) => {
        const requestedAt = Math.floor(Date.now() / 1000);
        const onComplete = () => {
            connection.off(Constants.ResponseCodes.EndOfContacts, onComplete);
            connection.off(Constants.ResponseCodes.Err, onError);
            resolve();
        };
        const onError = (error) => {
            connection.off(Constants.ResponseCodes.EndOfContacts, onComplete);
            connection.off(Constants.ResponseCodes.Err, onError);
            reject(error);
        };

        connection.once(Constants.ResponseCodes.EndOfContacts, onComplete);
        connection.once(Constants.ResponseCodes.Err, onError);

        connection.sendCommandGetContacts(since)
            .then(() => {
                lastContactRequestAt = requestedAt;
            })
            .catch(onError);
    });
}

async function refreshContacts() {
    contactRefreshQueue = contactRefreshQueue
        .then(() => requestContacts(lastContactRequestAt))
        .catch((error) => {
            console.error("MeshCore contact refresh failed", error);
        });

    await contactRefreshQueue;
}

function createMentionRegex(displayName) {
    const escapedDisplayName = displayName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
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

async function addContact(contactInfo) {
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

async function handleChannelMessage(message) {
    const senderMatch = message.text.match(/^([^:]+):\s*/);
    const senderName = senderMatch ? senderMatch[1] : null;

    // Check for contact info in the message text
    const contactInfo = parseContactInfo(message.text);
    if (contactInfo) {
        // If we don't know the contact, add them to our contacts list
        const contactKey = contactPrefixKey(contactInfo.publicKey);
        if (!contactNamesByPrefix.has(contactKey)) {
            await addContact(contactInfo);
        }

        // If we have our companion info, send it back as a response
        if (companionInfo) {
            await connection.sendChannelTextMessage(message.channelIdx, formatContactInfo(companionInfo));
        }

        console.log(`[meshcore] [channel] [contact] ${message.text}`);
        return;
    }

    const mentionMatch = mentionRegex?.exec(message.text);
    if (!mentionMatch) {
        // If it's not a contact and not a mention, ignore it for now
        console.log(`[meshcore] [channel] [message] ${message.text}`);
        return;
    }

    const text = message.text.slice(mentionMatch.index + mentionMatch[0].length).trim();
    if (text) {
        console.log(`[meshcore] [channel] [mention] ${senderName ?? "unknown"}: ${text}`);

        const item = { source: "meshcore", from: senderName, type: "text", text };

        // TODO: Hand off `item` to the receipt rendering logic
        console.log(item);
    }
}

async function handleContactMessage(message) {
    const contactName = contactNamesByPrefix.get(contactPrefixKey(message.pubKeyPrefix));
    if (!contactName) {
        console.warn("Received direct message from unknown MeshCore contact");
    }

    const senderName = contactName ?? Buffer.from(message.pubKeyPrefix).toString("hex");
    console.log(`[meshcore] [direct] [message] ${senderName}: ${message.text}`);

    const item = { source: "meshcore", from: senderName, type: "text", text: message.text };

    // TODO: Hand off `item` to the receipt rendering logic
    console.log(item);
}

async function handleWaitingMessage(message) {
    if (message.channelMessage) {
        await handleChannelMessage(message.channelMessage);
    } else if (message.contactMessage) {
        await handleContactMessage(message.contactMessage);
    }
}

async function fetchWaitingMessages() {
    messageHandlingQueue = messageHandlingQueue
        .then(async () => {
            const waitingMessages = await connection.getWaitingMessages();
            for (const message of waitingMessages) {
                await handleWaitingMessage(message);
            }
        })
        .catch((error) => {
            console.error("MeshCore message handling failed", error);
        });

    await messageHandlingQueue;
}

connection.on("connected", async () => {
    companionInfo = await connection.getSelfInfo();
    mentionRegex = createMentionRegex(companionInfo.name);

    // update clock on meshcore device
    await connection.syncDeviceTime();

    await refreshContacts();

    console.log(`Connected as '${companionInfo.name}' with ${contactNamesByPrefix.size} known contacts`);

    await fetchWaitingMessages();
});

connection.on(Constants.PushCodes.MsgWaiting, async () => {
    // Request new messages as they arrive
    await fetchWaitingMessages();
});

connection.on(Constants.PushCodes.Advert, async () => {
    // Update contacts when a new one is added
    await refreshContacts();
});

connection.on(Constants.ResponseCodes.Contact, (contact) => {
    contactNamesByPrefix.set(contactPrefixKey(contact.publicKey), contact.advName);
});

if (logRxData) {
    connection.on(Constants.PushCodes.LogRxData, async ({ lastSnr, lastRssi, raw }) => {
        const packet = Packet.fromBytes(raw);
        console.log(`[rx] SNR ${lastSnr}, RSSI ${lastRssi}:`, packet);
    });
}

await connection.connect();
