/**
 * Chess Arena v4 - Spectators, Usernames, Timer, Emojis
 */
const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const COMMISSION_RATE = 0.10;
const GAME_TIME_MS = 10 * 60 * 1000; // 10 minutes per player

const connection = new Connection(SOLANA_RPC, 'confirmed');
let wallet = null, WALLET_ADDRESS = '';

if (WALLET_PRIVATE_KEY) {
    try {
        wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
        WALLET_ADDRESS = wallet.publicKey.toString();
        console.log('✅ Wallet:', WALLET_ADDRESS);
    } catch (e) { console.error('Wallet error:', e.message); }
}

const rooms = new Map();
const processedTx = new Set();
const usernames = new Map(); // wallet -> username

const INIT_BOARD = [
    ['r','n','b','q','k','b','n','r'],
    ['p','p','p','p','p','p','p','p'],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['P','P','P','P','P','P','P','P'],
    ['R','N','B','Q','K','B','N','R']
];

function genCode() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
}

function getUsername(wallet) {
    return usernames.get(wallet) || wallet?.slice(0, 6) + '...' || 'Anonymous';
}

// ═══════════════════════════════════════════════════════════════
// USERNAME MANAGEMENT
// ═══════════════════════════════════════════════════════════════
app.post('/api/username', (req, res) => {
    const { wallet, username } = req.body;
    if (!wallet || !username) return res.status(400).json({ error: 'Missing data' });
    if (username.length > 20) return res.status(400).json({ error: 'Max 20 chars' });
    
    usernames.set(wallet, username.trim());
    console.log('Username set:', wallet.slice(0,8), '->', username);
    res.json({ success: true, username: username.trim() });
});

app.get('/api/username/:wallet', (req, res) => {
    const username = usernames.get(req.params.wallet);
    res.json({ success: true, username: username || null });
});

// ═══════════════════════════════════════════════════════════════
// CONFIG & HEALTH
// ═══════════════════════════════════════════════════════════════
app.get('/api/config', (req, res) => {
    res.json({ walletAddress: WALLET_ADDRESS, usdcMint: USDC_MINT.toString(), commissionRate: COMMISSION_RATE, gameTimeMs: GAME_TIME_MS });
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', walletAddress: WALLET_ADDRESS, rooms: rooms.size });
});

app.get('/api/blockhash', async (req, res) => {
    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
        res.json({ success: true, blockhash, lastValidBlockHeight });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ROOM MANAGEMENT
// ═══════════════════════════════════════════════════════════════
app.post('/api/rooms', (req, res) => {
    const { entryFee, creatorWallet } = req.body;
    const code = genCode();
    const room = {
        code, entryFee: parseFloat(entryFee) || 5, status: 'waiting_players',
        confirmedPayments: 0,
        board: INIT_BOARD.map(r => [...r]),
        currentTurn: 'white',
        lastMove: null,
        winner: null,
        // Timer
        whiteTimeMs: GAME_TIME_MS,
        blackTimeMs: GAME_TIME_MS,
        lastMoveTime: null,
        // Players & Spectators
        players: [{ id: 0, wallet: creatorWallet, name: getUsername(creatorWallet), color: 'white', paid: false }],
        spectators: [],
        emojis: [] // Recent emojis from spectators
    };
    rooms.set(code, room);
    console.log('Room created:', code);
    res.json({ success: true, room: sanitizeRoom(room) });
});

app.post('/api/rooms/:code/join', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.players.length >= 2) return res.status(400).json({ error: 'Full' });
    
    const { playerWallet } = req.body;
    room.players.push({ id: 1, wallet: playerWallet, name: getUsername(playerWallet), color: 'black', paid: false });
    room.status = 'waiting_payments';
    console.log('Player joined:', room.code);
    res.json({ success: true, room: sanitizeRoom(room) });
});

// Spectator join
app.post('/api/rooms/:code/spectate', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const { wallet } = req.body;
    const spectator = { wallet, name: getUsername(wallet), joinedAt: Date.now() };
    
    // Don't add duplicate
    if (!room.spectators.find(s => s.wallet === wallet)) {
        room.spectators.push(spectator);
        console.log('Spectator joined:', room.code, spectator.name);
    }
    
    res.json({ success: true, room: sanitizeRoom(room) });
});

// Spectator emoji
app.post('/api/rooms/:code/emoji', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    const { wallet, emoji } = req.body;
    const allowedEmojis = ['👏', '🔥', '😮', '😂', '👀', '💀', '🎉', '👍', '👎', '❤️'];
    if (!allowedEmojis.includes(emoji)) return res.status(400).json({ error: 'Invalid emoji' });
    
    room.emojis.push({ emoji, name: getUsername(wallet), time: Date.now() });
    // Keep only last 20 emojis
    if (room.emojis.length > 20) room.emojis = room.emojis.slice(-20);
    
    res.json({ success: true });
});

app.get('/api/rooms/:code', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, room: sanitizeRoom(room) });
});

app.get('/api/rooms/:code/payments', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    res.json({
        success: true, status: room.status, confirmedPayments: room.confirmedPayments,
        canStartGame: room.confirmedPayments >= 2 && room.players.length >= 2,
        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, paymentConfirmed: p.paid }))
    });
});

app.get('/api/rooms/:code/state', (req, res) => {
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    
    // Update time if game is active
    updateTimer(room);
    
    res.json({
        success: true, status: room.status, board: room.board, currentTurn: room.currentTurn,
        lastMove: room.lastMove, winner: room.winner,
        whiteTimeMs: room.whiteTimeMs, blackTimeMs: room.blackTimeMs,
        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, paymentConfirmed: p.paid })),
        spectatorCount: room.spectators.length,
        emojis: room.emojis.slice(-10) // Last 10 emojis
    });
});

function updateTimer(room) {
    if (room.status !== 'playing' || !room.lastMoveTime) return;
    
    const elapsed = Date.now() - room.lastMoveTime;
    if (room.currentTurn === 'white') {
        room.whiteTimeMs = Math.max(0, room.whiteTimeMs - elapsed);
        if (room.whiteTimeMs <= 0) {
            room.winner = 1; // Black wins on time
            room.status = 'finished';
            console.log('White timeout! Black wins:', room.code);
            handlePayout(room);
        }
    } else {
        room.blackTimeMs = Math.max(0, room.blackTimeMs - elapsed);
        if (room.blackTimeMs <= 0) {
            room.winner = 0; // White wins on time
            room.status = 'finished';
            console.log('Black timeout! White wins:', room.code);
            handlePayout(room);
        }
    }
    room.lastMoveTime = Date.now();
}

function sanitizeRoom(room) {
    return {
        ...room,
        walletAddress: WALLET_ADDRESS,
        players: room.players.map(p => ({ id: p.id, name: p.name, color: p.color, paid: p.paid })),
        spectatorCount: room.spectators.length
    };
}

// ═══════════════════════════════════════════════════════════════
// PAYMENT
// ═══════════════════════════════════════════════════════════════
app.post('/api/payments/verify', async (req, res) => {
    const { roomCode, txSignature, playerWallet } = req.body;
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.status === 'finished') return res.status(400).json({ error: 'Game finished' });
    if (room.status === 'playing') return res.status(400).json({ error: 'Game started' });
    if (processedTx.has(txSignature)) return res.status(400).json({ error: 'Already processed' });
    
    try {
        const tx = await connection.getTransaction(txSignature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) return res.status(400).json({ error: 'TX not found' });
        if (tx.meta?.err) return res.status(400).json({ error: 'TX failed' });
        
        const player = room.players.find(p => !p.paid);
        if (!player) return res.status(400).json({ error: 'All paid' });
        
        player.paid = true;
        player.wallet = playerWallet;
        player.name = getUsername(playerWallet);
        room.confirmedPayments++;
        processedTx.add(txSignature);
        
        if (room.confirmedPayments >= 2 && room.players.length >= 2) {
            room.status = 'playing';
            room.lastMoveTime = Date.now();
        }
        console.log('Payment verified:', roomCode, 'Player', player.id);
        
        let msg = 'Payment confirmed!';
        if (room.status === 'playing') msg = 'Game starting!';
        
        res.json({ success: true, room: sanitizeRoom(room), message: msg });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// MOVE
// ═══════════════════════════════════════════════════════════════
app.post('/api/rooms/:code/move', (req, res) => {
    const { playerId, from, to } = req.body;
    const room = rooms.get(req.params.code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Not found' });
    if (room.status !== 'playing') return res.status(400).json({ error: 'Not playing' });
    if (room.winner !== null) return res.status(400).json({ error: 'Game over' });
    
    // Update timer before move
    updateTimer(room);
    if (room.winner !== null) {
        return res.json({ success: true, board: room.board, gameOver: true, winner: room.winner, timeout: true });
    }
    
    const player = room.players[playerId];
    if (!player) return res.status(400).json({ error: 'Invalid player' });
    if (player.color !== room.currentTurn) return res.status(400).json({ error: 'Not your turn' });
    
    const piece = room.board[from.row][from.col];
    if (!piece) return res.status(400).json({ error: 'No piece' });
    
    const pieceColor = piece === piece.toUpperCase() ? 'white' : 'black';
    if (pieceColor !== player.color) return res.status(400).json({ error: 'Not your piece' });
    
    const target = room.board[to.row][to.col];
    const capturedKing = target?.toLowerCase() === 'k';
    
    room.board[to.row][to.col] = piece;
    room.board[from.row][from.col] = '';
    room.lastMove = { from, to };
    room.lastMoveTime = Date.now();
    
    console.log('Move:', room.code, player.color, `${from.row},${from.col} -> ${to.row},${to.col}`);
    
    if (capturedKing) {
        room.winner = playerId;
        room.status = 'finished';
        console.log('Winner:', player.name);
        handlePayout(room);
        return res.json({ success: true, board: room.board, gameOver: true, winner: playerId });
    }
    
    room.currentTurn = room.currentTurn === 'white' ? 'black' : 'white';
    res.json({ 
        success: true, board: room.board, currentTurn: room.currentTurn, lastMove: room.lastMove,
        whiteTimeMs: room.whiteTimeMs, blackTimeMs: room.blackTimeMs
    });
});

// ═══════════════════════════════════════════════════════════════
// PAYOUT
// ═══════════════════════════════════════════════════════════════
async function handlePayout(room) {
    if (!wallet) return;
    
    const winner = room.players[room.winner];
    if (!winner?.wallet) return;
    
    const payout = room.entryFee * 2 * (1 - COMMISSION_RATE);
    try {
        const recipient = new PublicKey(winner.wallet);
        const senderATA = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
        const recipientATA = await getAssociatedTokenAddress(USDC_MINT, recipient);
        
        const ix = createTransferInstruction(senderATA, recipientATA, wallet.publicKey, Math.floor(payout * 1e6), [], TOKEN_PROGRAM_ID);
        const tx = new Transaction().add(ix);
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.sign(wallet);
        
        const sig = await connection.sendRawTransaction(tx.serialize());
        console.log('Payout sent:', payout, 'USDC, tx:', sig);
    } catch (e) { console.error('Payout error:', e.message); }
}

app.listen(PORT, () => console.log(`Chess Arena v4 on port ${PORT}`));
