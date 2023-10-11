import { parentPort } from "worker_threads"
import { Database } from "bun:sqlite";
import { Queue } from '@datastructures-js/queue';

const db = new Database("server.db")

try{
const createLiveChatMessages = `
    CREATE TABLE IF NOT EXISTS LiveChatMessages (
        messageId INTEGER PRIMARY KEY,
        sendDate INTEGER,
        channel TEXT,
        message TEXT,
        senderIntId INTEGER,
        repliesTo INTEGER,
        FOREIGN KEY (repliesTo) REFERENCES LiveChatMessages(messageId),
        FOREIGN KEY (senderIntId) REFERENCES Users(intId)
    )
`
db.exec(createLiveChatMessages)
const createLiveChatReactions = `
    CREATE TABLE IF NOT EXISTS LiveChatReactions (
        messageId INTEGER,
        reaction TEXT,
        senderIntId INTEGER,
        FOREIGN KEY (messageId) REFERENCES LiveChatMessages(messageId),
        FOREIGN KEY (senderIntId) REFERENCES Users(intId)
    )
`
db.exec(createLiveChatReactions)
const createPlaceChatMessages = `
    CREATE TABLE IF NOT EXISTS PlaceChatMessages (
        messageId INTEGER PRIMARY KEY,
        sendDate INTEGER,
        message TEXT,
        senderIntId INTEGER,
        x INTEGER,
        y INTEGER,
        FOREIGN KEY (senderIntId) REFERENCES Users(intId)
    )
`
db.exec(createPlaceChatMessages)
const createBans = `
    CREATE TABLE IF NOT EXISTS Bans (
        banId INTEGER PRIMARY KEY,
        userIntId INTEGER UNIQUE,
        startDate INTEGER,
        finishDate INTEGER,
        moderatorIntId INTEGER,
        reason TEXT,
        userAppeal TEXT,
        appealRejected INTEGER,
        FOREIGN KEY (userIntId) REFERENCES Users(intId),
        FOREIGN KEY (moderatorIntId) REFERENCES Users(intId)
    )
`
db.exec(createBans)
const createMutes = `
    CREATE TABLE IF NOT EXISTS Mutes (
        muteId INTEGER PRIMARY KEY,
        startDate INTEGER,
        finishDate INTEGER,
        userIntId INTEGER UNIQUE,
        moderatorIntId INTEGER,
        reason TEXT,
        userAppeal TEXT,
        appealRejected INTEGER,
        FOREIGN KEY (userIntId) REFERENCES Users(intId),
        FOREIGN KEY (moderatorIntId) REFERENCES Users(intId)
    )
`
db.exec(createMutes)
const createUsers = `
    CREATE TABLE IF NOT EXISTS Users (
        intId INTEGER PRIMARY KEY,
        chatName TEXT,
        token TEXT NOT NULL,
        lastJoined INTEGER,
        pixelsPlaced INTEGER,
        playTimeSeconds INTEGER
    )
`
db.exec(createUsers)
const createUserIps = `
    CREATE TABLE IF NOT EXISTS KnownIps (
        userIntId INTERGER NOT NULL,
        ip TEXT NOT NULL,
        lastUsed INTEGER,
        FOREIGN KEY (userIntId) REFERENCES Users(intId)
    )
` // ip and userIntId combined form a composite key to identify a record
db.exec(createUserIps)

const insertLiveChat = db.prepare("INSERT INTO LiveChatMessages (messageId, message, sendDate, channel, senderIntId, repliesTo) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
const insertPlaceChat = db.prepare("INSERT INTO PlaceChatMessages (messageId, message, sendDate, senderIntId, x, y) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
const updatePixelPlaces = db.prepare("UPDATE Users SET pixelsPlaced = pixelsPlaced + ?1 WHERE intId = ?2")

const pixelPlaces = new Map() // intId, count
const liveChatInserts = new Queue()
const placeChatInserts = new Queue()
function performBulkInsertions() {
    // insert all new pixel places
    db.transaction(() => {
        for (let placePair of pixelPlaces) {
            updatePixelPlaces.run(placePair[1], placePair[0])
            pixelPlaces.delete(placePair)
        }
    })()
    
    // insert all new chats
    db.transaction(() => {
        while (!liveChatInserts.isEmpty()) {
            const data = liveChatInserts.dequeue()
            insertLiveChat.run(...data)
        }
        while (!placeChatInserts.isEmpty()) {
            const data = placeChatInserts.dequeue()
            insertPlaceChat.run(...data)
        }
    })()
}
setInterval(performBulkInsertions, 10000)

const internal = {
    /** @param {{ newName: string, intId: number }} data */
    setUserChatName: function(data) {
        const updateQuery = db.query("UPDATE Users SET chatName = ?1 WHERE intId = ?2")
        updateQuery.run(data.newName, data.intId)
    },
    getUserChatName: function(intId) {
        const getNameQuery = db.query("SELECT chatName FROM Users WHERE intId = ?1")
        const result = getNameQuery.get(intId)
        return result ? result.chatName : null
    },
    /** @param {{ token: string, ip: string }} data */
    authenticateUser: function(data) {
        const selectUser = db.query("SELECT * FROM Users WHERE token = ?1")
        const epochMs = Date.now()
        
        let user = selectUser.get(data.token)
        if (!user)  { // Create new user
            const insertUser = db.query(
                "INSERT INTO Users (token, lastJoined, pixelsPlaced, playTimeSeconds) VALUES (?1, ?2, ?3, ?4) RETURNING intId")
            user = insertUser.get(data.token, epochMs, 0, 0)
            return user.intId
        }
        else { // Update last joined
            const updateUser = db.query("UPDATE Users SET lastJoined = ?1 WHERE intId = ?2")
            updateUser.run(epochMs, user.intId)
        }
        // Add known IP if not already there
        const getIpsQuery = db.query("SELECT * FROM KnownIps WHERE userIntId = ?1")
        let ipExists = false
        for (let ipRecord of getIpsQuery.all(user.intId)) {
            if (ipRecord.ip === data.ip) ipExists = true
        }
        if (ipExists) { // Update last used
            const updateIp = db.query("UPDATE KnownIps SET lastUsed = ?1 WHERE userIntId = ?2 AND ip = ?3")
            updateIp.run(epochMs, user.intId, data.ip)
        }
        else { // Create new
            const createIp = db.query("INSERT INTO KnownIps (userIntId, ip, lastUsed) VALUES (?1, ?2, ?3)")
            createIp.run(user.intId, data.ip, epochMs)
        }
        return user.intId
    },
    updatePixelPlace: function(intId) {
        pixelPlaces.set(intId, (pixelPlaces.get(intId)||0) + 1)
    },
    getMaxLiveChatId: function() {
        const getMaxMessageId = db.query("SELECT MAX(messageID) AS maxMessageID FROM LiveChatMessages")
        const maxMessageID = getMaxMessageId.get().maxMessageID || 0
        return maxMessageID      
    },
    getMaxPlaceChatId: function() {
        const getMaxMessageId = db.query("SELECT MAX(messageID) AS maxMessageID FROM PlaceChatMessages")
        const maxMessageID = getMaxMessageId.get().maxMessageID || 0
        return maxMessageID
    },
    commitShutdown: function() {
        performBulkInsertions()
        db.close()
    },
    // Send date is seconds unix epoch offset, we just hope whoever calls these funcs func passed in the args in the right order
    // else the DB is screwed.
    /** @param {[ messageId: number, message: string, sendDate: number, channel: string, senderIntId: number, repliesTo: number  ]} data */
    insertLiveChat: function(data) {
        if (!Array.isArray(data) || data.length < 5) {
            return
        }
        if (data.length == 5) {
            // repliesTo default value
            data.push(null)
        }
        liveChatInserts.push(data)
    },
    /** @param {[messageId: number, message: string, sendDate: number, senderIntId: number, x: number, y: number ]} data */
    insertPlaceChat: function(data) {
        if (!Array.isArray(data) || data.length < 6) {
            return
        }
        placeChatInserts.push(data)
    },
    /** @param {{ stmt: string, params: any }} data */
    exec: function(data) {
        try {
            let query = db.query(data.stmt)
            return (typeof data.params[Symbol.iterator] === 'function'
                ? query.all(...data.params)
                : query.all(data.params))
        }
        catch(err) {
            console.log(err)
            return null
        }
    },
}

parentPort.on("message", (message) => {
    const result = internal[message.call] && internal[message.call](message.data)
    parentPort.postMessage({ handle: message.handle, data: result })
})
}
catch(e){
    console.error("Error from DB worker:", e)
}