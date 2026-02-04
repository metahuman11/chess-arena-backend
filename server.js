/**
 * Chess Arena - Solana Backend v3
 * Real Multiplayer - No AI, proper move sync
 */

const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createTransferInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// CONFIG
const PORT = process.env.PORT || 3001;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const COMMISSION_RATE = 0.10;

const connection = new Connection(SOLANA_RPC, 'confirmed');

let wallet = null;
let WALLET_ADDRESS = '';

if (WALLET_PRIVATE_KEY) {
    try {
        const secretKey = bs58.decode(WALLET_PRIVATE_KEY);
        wallet = Keypair.fromSecretKey(secretKey);
        WALLET_ADDRESS = wallet.publicKey.toString();
        console.log('✅ Wallet loaded:', WALLET_ADDRESS);
    } catch (e) {
        console.error('❌ Failed to load wallet:', e.message);
    }
}

// DATABASE
const rooms = new Map();
const processedSignatures = new Set();

// Initial chess board
const INITIAL_BOARD = [
    ['r','n','b','q','k','b','n','r'],
    ['p','p','p','p','p','p','p','p'],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['','','','','','','',''],
    ['P','P','P','P','P','P','P','P'],
    ['R','N','B','Q','K','B','N','R']
];

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// Get room for API response
function getRoomResponse(room, forPlayerId = null) {
    return {
        code: room.code,
        entryFee: room.entryFee,
        status: room.status,
        walletAddress: WALLET_ADDRESS,
        confirmedPayments: room.confirmedPayments,
        requiredPayments: 2,
        canStartGame: room.confirmedPayments >= 2,
        prizePool: room.entryFee * room.confirmedPayments,
        currentTurn: room.currentTurn, // 'white' or 'black'
        board: room.board,
        lastMove: room.lastMove,
        winner: room.winner,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            paymentConfirmed: p.paymentConfirmed
        }))
    };
}

// ═══════════════════════════════════════════════════════════════
// ROOM ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/config', (req, res) => {
    res.json({
        walletAddress: WALLET_ADDRESS,
        usdcMint: USDC_MINT.toString(),
        commissionRate: COMMISSION_RATE
    });
});

// Create room
app.post('/api/rooms', (req, res) => {
    const { entryFee, creatorName, creatorWallet } = req.body;
    
    if (!WALLET_ADDRESS) {
        return res.status(500).json({ error: 'Backend wallet not configured' });
    }
    
    const roomCode = generateRoomCode();
    const room = {
        code: roomCode,
        entryFee: parseFloat(entryFee) || 5,
        status: 'waiting_players',
        confirmedPayments: 0,
        board: INITIAL_BOARD.map(r => [...r]),
        currentTurn: 'white',
        lastMove: null,
        winner: null,
        players: [{
            id: 0,
            name: creatorName || 'Player 1',
            wallet: creatorWallet || null,
            color: 'white',
            paymentConfirmed: false,
            txSignature: null
        }],
        createdAt: Date.now()
    };
    
    rooms.set(roomCode, room);
    console.log(`🆕 Room created: ${roomCode}`);
    
    res.json({ success: true, room: getRoomResponse(room) });
});

// Join room
app.post('/api/rooms/:code/join', (req, res) => {
    const { code } = req.params;
    const { playerName, playerWallet } = req.body;
    
    const room = rooms.get(code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.players.length >= 2) return res.status(400).json({ error: 'Room is full' });
    if (room.status !== 'waiting_players') return res.status(400).json({ error: 'Cannot join' });
    
    room.players.push({
        id: 1,
        name: playerName || 'Player 2',
        wallet: playerWallet || null,
        color: 'black',
        paymentConfirmed: false,
        txSignature: null
    });
    
    room.status = 'waiting_payments';
    console.log(`🚪 Player joined: ${code}`);
    
    res.json({ success: true, room: getRoomResponse(room) });
});

// Get room status
app.get('/api/rooms/:code', (req, res) => {
    const { code } = req.params;
    const room = rooms.get(code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ success: true, room: getRoomResponse(room) });
});

// Get game state (polling endpoint for multiplayer sync)
app.get('/api/rooms/:code/state', (req, res) => {
    const { code } = req.params;
    const room = rooms.get(code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    
    res.json({
        success: true,
        status: room.status,
        board: room.board,
        currentTurn: room.currentTurn,
        lastMove: room.lastMove,
        winner: room.winner,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            color: p.color,
            paymentConfirmed: p.paymentConfirmed
        }))
    });
});

// Payment status
app.get('/api/rooms/:code/payments', async (req, res) => {
    const { code } = req.params;
    const room = rooms.get(code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    
    res.json({
        success: true,
        status: room.status,
        confirmedPayments: room.confirmedPayments,
        requiredPayments: 2,
        canStartGame: room.confirmedPayments >= 2,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            paymentConfirmed: p.paymentConfirmed
        }))
    });
});

// ═══════════════════════════════════════════════════════════════
// MAKE MOVE - Real multiplayer
// ═══════════════════════════════════════════════════════════════
app.post('/api/rooms/:code/move', (req, res) => {
    const { code } = req.params;
    const { playerId, from, to } = req.body; // from: {row, col}, to: {row, col}
    
    const room = rooms.get(code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.status !== 'playing') return res.status(400).json({ error: 'Game not started' });
    if (room.winner !== null) return res.status(400).json({ error: 'Game already ended' });
    
    const player = room.players[playerId];
    if (!player) return res.status(400).json({ error: 'Invalid player' });
    
    // Check if it's this player's turn
    if (player.color !== room.currentTurn) {
        return res.status(400).json({ error: 'Not your turn' });
    }
    
    // Validate move
    const piece = room.board[from.row][from.col];
    if (!piece) return res.status(400).json({ error: 'No piece at source' });
    
    const pieceColor = piece === piece.toUpperCase() ? 'white' : 'black';
    if (pieceColor !== player.color) {
        return res.status(400).json({ error: 'Not your piece' });
    }
    
    // Check if capturing king (win condition)
    const targetPiece = room.board[to.row][to.col];
    const capturedKing = targetPiece?.toLowerCase() === 'k';
    
    // Make the move
    room.board[to.row][to.col] = piece;
    room.board[from.row][from.col] = '';
    room.lastMove = { from, to, piece };
    
    console.log(`♟️ Move: ${code} - ${player.color} ${from.row},${from.col} → ${to.row},${to.col}`);
    
    // Check win
    if (capturedKing) {
        room.winner = playerId;
        room.status = 'finished';
        console.log(`🏆 Winner: ${player.name} (${player.color})`);
        
        // Trigger payout
        handlePayout(room);
        
        return res.json({
            success: true,
            gameOver: true,
            winner: playerId,
            board: room.board
        });
    }
    
    // Switch turn
    room.currentTurn = room.currentTurn === 'white' ? 'black' : 'white';
    
    res.json({
        success: true,
        board: room.board,
        currentTurn: room.currentTurn,
        lastMove: room.lastMove
    });
});

// ═══════════════════════════════════════════════════════════════
// PAYMENT VERIFICATION
// ═══════════════════════════════════════════════════════════════
app.post('/api/payments/verify', async (req, res) => {
    const { roomCode, txSignature, playerWallet } = req.body;
    
    const room = rooms.get(roomCode.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    if (room.status !== 'waiting_payments') return res.status(400).json({ error: 'Not accepting payments' });
    if (processedSignatures.has(txSignature)) return res.status(400).json({ error: 'Already processed' });
    
    try {
        console.log(`🔍 Verifying: ${txSignature}`);
        
        const tx = await connection.getTransaction(txSignature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });
        
        if (!tx) return res.status(400).json({ error: 'Transaction not found' });
        if (tx.meta?.err) return res.status(400).json({ error: 'Transaction failed' });
        
        // Find unpaid player
        const player = room.players.find(p => !p.paymentConfirmed);
        if (!player) return res.status(400).json({ error: 'All players already paid' });
        
        // Mark as paid
        player.paymentConfirmed = true;
        player.txSignature = txSignature;
        player.wallet = playerWallet;
        room.confirmedPayments++;
        processedSignatures.add(txSignature);
        
        console.log(`✅ Payment confirmed: ${roomCode} - Player ${player.id}`);
        
        // Check if game can start
        if (room.confirmedPayments >= 2) {
            room.status = 'playing';
            console.log(`🎮 GAME STARTED: ${roomCode}`);
        }
        
        res.json({
            success: true,
            room: getRoomResponse(room),
            message: room.confirmedPayments >= 2 ? 'Game starting!' : 'Waiting for opponent payment'
        });
        
    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// PAYOUT
// ═══════════════════════════════════════════════════════════════
async function handlePayout(room) {
    const winner = room.players[room.winner];
    if (!winner || !winner.wallet || !wallet) {
        console.log('⚠️ Cannot auto-payout');
        return;
    }
    
    const totalPool = room.entryFee * 2;
    const commission = totalPool * COMMISSION_RATE;
    const payout = totalPool - commission;
    
    try {
        const recipient = new PublicKey(winner.wallet);
        const senderATA = await getAssociatedTokenAddress(USDC_MINT, wallet.publicKey);
        const recipientATA = await getAssociatedTokenAddress(USDC_MINT, recipient);
        
        const amount = Math.floor(payout * 1_000_000);
        
        const transferIx = createTransferInstruction(
            senderATA, recipientATA, wallet.publicKey, amount, [], TOKEN_PROGRAM_ID
        );
        
        const tx = new Transaction().add(transferIx);
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        tx.sign(wallet);
        
        const sig = await connection.sendRawTransaction(tx.serialize());
        await connection.confirmTransaction(sig, 'confirmed');
        
        room.payoutTx = sig;
        console.log(`💸 Payout sent: ${payout} USDC → ${winner.wallet}`);
        
    } catch (e) {
        console.error('Payout error:', e.message);
    }
}

// Manual end game (for testing)
app.post('/api/rooms/:code/end', async (req, res) => {
    const { code } = req.params;
    const { winnerId } = req.body;
    
    const room = rooms.get(code.toUpperCase());
    if (!room) return res.status(404).json({ error: 'Room not found' });
    
    room.winner = winnerId;
    room.status = 'finished';
    
    await handlePayout(room);
    
    const winner = room.players[winnerId];
    const payout = room.entryFee * 2 * (1 - COMMISSION_RATE);
    
    res.json({
        success: true,
        winner: winner?.name,
        payout,
        payoutTx: room.payoutTx
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        walletAddress: WALLET_ADDRESS || 'NOT CONFIGURED',
        activeRooms: rooms.size
    });
});

app.listen(PORT, () => {
    console.log(`♔ Chess Arena v3 - Port ${PORT}`);
    console.log(`  Wallet: ${WALLET_ADDRESS || 'NOT SET'}`);
});
