const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@fizzxydev/baileys-pro');
const { Boom } = require('@hapi/boom');
const path = require('path');
const express = require('express');
const fs = require('fs/promises'); // Used for managing the auth folder

// Initialize Express app
const app = express();
const port = 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Global variables to hold the socket instance and connection state
let sock;
let connectionStatus = 'disconnected'; // Can be: disconnected, connecting, connected, waiting_for_pair_code, error
const AUTH_DIR = path.resolve(__dirname, 'auth_info_baileys');

// --- Main Connection & Disconnection Logic ---

function connectToWhatsApp(phoneNumber = null) {
    // Use a promise to handle the asynchronous nature of getting the pairing code
    return new Promise(async (resolve, reject) => {
        await disconnect(); // Clean up previous session

        connectionStatus = 'connecting';
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        sock = makeWASocket({
            printQRInTerminal: false,
            auth: state,
            browser: ['Chrome (Linux)', '', '']
        });

        // Listen for connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // This is the key change: We wait for the 'qr' event to know it's time to request the code.
            // This is the correct moment to ask for a pairing code.
            if (qr && phoneNumber) {
                console.log('Authentication required. Requesting pairing code...');
                try {
                    // **THE FIX IS HERE: Using the correct "Normal Pairing" method**
                    const code = await sock.requestPairingCode(phoneNumber);
                    connectionStatus = 'waiting_for_pair_code';
                    console.log(`✅ Pairing code generated: ${code}`);
                    resolve(code); // Resolve the promise with the REAL pairing code
                } catch (error) {
                    console.error('❌ Failed to request pairing code inside event handler:', error);
                    connectionStatus = 'error';
                    reject(error); // Reject the promise if code request fails
                }
            }

            if (connection === 'open') {
                connectionStatus = 'connected';
                console.log('✅ Connection opened and ready to use.');
                resolve(null); // Resolve with null if already authenticated
            }

            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
                console.log('Connection closed due to:', lastDisconnect?.error, 'statusCode:', reason);
                connectionStatus = 'disconnected';
                // This will reject the promise if the connection closes before we get a code
                reject(new Error('Connection closed before authentication could complete.'));
            }
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', (event) => {
            console.log('Received messages:', JSON.stringify(event.messages, null, 2));
        });
    });
}


async function disconnect() {
    if (sock) {
        await sock.logout();
        sock = null;
    }
    connectionStatus = 'disconnected';
    try {
        await fs.rm(AUTH_DIR, { recursive: true, force: true });
        console.log('Authentication session folder cleared.');
    } catch (error) {
        // Ignore error if folder doesn't exist
    }
}

// --- API Endpoints ---

app.post('/login', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ success: false, error: 'Phone number is required.' });
    }

    try {
        const code = await connectToWhatsApp(phoneNumber);
        if (code) {
            res.status(200).json({ success: true, message: 'Pairing code requested.', code: code });
        } else {
            res.status(200).json({ success: true, message: 'Already connected.' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: error.message || 'An error occurred during login.' });
    }
});

app.post('/logout', async (req, res) => {
    try {
        await disconnect();
        res.status(200).json({ success: true, message: 'Logged out successfully.' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, error: 'An error occurred during logout.' });
    }
});

app.get('/status', (req, res) => {
    res.status(200).json({ status: connectionStatus });
});

// --- Your existing endpoints below ---

app.post('/send-text-message', async (req, res) => {
    const { jid, text } = req.body;
    if (!jid || !text) return res.status(400).json({ success: false, error: 'Missing jid or text' });
    if (connectionStatus !== 'connected') return res.status(503).json({ success: false, error: 'WhatsApp client is not connected.' });
    try {
        await sock.sendMessage(jid, { text: text });
        res.status(200).json({ success: true, message: 'Text message sent successfully.' });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to send text message.' });
    }
});

// ... (All your other message sending and group management endpoints remain the same) ...

// --- Start the Server ---
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
    fs.access(path.join(AUTH_DIR, 'creds.json'))
        .then(() => {
            console.log('Existing session found. Attempting to reconnect...');
            connectToWhatsApp();
        })
        .catch(() => {
            console.log('No existing session found. Please log in via the web UI.');
        });
});
