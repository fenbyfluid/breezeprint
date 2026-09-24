import { NodeJSSerialConnection, Constants, Packet } from "@liamcottle/meshcore.js";

const connection = new NodeJSSerialConnection("/dev/ttyACM0");

async function fetchWaitingMessages(connection) {
    const waitingMessages = await connection.getWaitingMessages();
    for (const message of waitingMessages) {
        console.log(message);
    }
}

// wait until connected
connection.on("connected", async () => {
    // we are now connected
    console.log("connected!");

    // update clock on meshcore device
    await connection.syncDeviceTime();

    await fetchWaitingMessages(connection);

    // log contacts
    /*
    const contacts = await connection.getContacts();
    for(const contact of contacts) {
        console.log(`Contact: ${contact.advName}`);
    }
    */

    // disconnect
    //connection.close();
});

// build reverse push code map
const eventNames = new Map();
for (const name in Constants.ResponseCodes) {
    eventNames.set(Constants.ResponseCodes[name], name);
}
for (const name in Constants.PushCodes) {
    eventNames.set(Constants.PushCodes[name], name);
}

// hack to capture all events for dev
const originalEmit = connection.emit;
connection.emit = function (ev) {
    if (ev !== 'tx' && ev !== 'rx' && ev !== Constants.PushCodes.LogRxData) {
        console.log(eventNames.get(ev), Array.from(arguments));
    }

    return originalEmit.apply(this, arguments);
};

// raw packets
connection.on(Constants.PushCodes.LogRxData, async ({ lastSnr, lastRssi, raw }) => {
    const packet = Packet.fromBytes(raw);
    console.log('LogRxData(Parsed)', { lastSnr, lastRssi, raw, packet, payload: packet.parsePayload() });
});

// request new messages as they arrive
connection.on(Constants.PushCodes.MsgWaiting, async () => {
    await fetchWaitingMessages(connection);
});

// connect to meshcore device
await connection.connect();
