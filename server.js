const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static('public'));

// In-memory room storage
const rooms = new Map();

// Helper: Generate 4-letter room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => 
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

// Helper: Create initial game state
function createGameState(totalRounds = 20) {
  return {
    status: 'waiting',
    currentRound: 0,
    totalRounds,
    roundActive: false,
    sharedRoundScore: 0,
    rollCount: 0,
    currentTurnIndex: 0
  };
}

// Helper: Deep clone for undo
function cloneState(room) {
  return JSON.parse(JSON.stringify({
    players: room.players,
    gameState: room.gameState
  }));
}

// Helper: Save state to history
function saveHistory(room) {
  room.history.push(cloneState(room));
  // Keep last 10 states
  if (room.history.length > 10) room.history.shift();
}

// Helper: Calculate dice result
function processDiceRoll(room, die1, die2) {
  const total = die1 + die2;
  const isDoubles = die1 === die2;
  const { rollCount, sharedRoundScore } = room.gameState;
  
  let newScore = sharedRoundScore;
  let roundDead = false;
  
  if (rollCount < 3) {
    // First 3 rolls
    if (total === 7) {
      newScore += 70;
    } else {
      newScore += total;
    }
  } else {
    // After 3 rolls
    if (total === 7) {
      roundDead = true;
      newScore = 0;
    } else if (isDoubles) {
      newScore *= 2;
    } else {
      newScore += total;
    }
  }
  
  return { newScore, roundDead, isDoubles };
}

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Create room
  socket.on('create_room', ({ playerName }) => {
    const roomCode = generateRoomCode();
    const room = {
      roomCode,
      hostId: socket.id,
      players: [{
        id: socket.id,
        name: playerName,
        lockedScore: 0,
        bankedThisRound: false,
        eliminated: false,
        turnOrder: 0
      }],
      gameState: createGameState(),
      history: []
    };
    
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    socket.emit('room_created', { roomCode, playerId: socket.id });
    io.to(roomCode).emit('game_state_update', room);
  });
  
  // Join room
  socket.on('join_room', ({ roomCode, playerName }) => {
    const room = rooms.get(roomCode.toUpperCase());
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    if (room.gameState.status !== 'waiting') {
      socket.emit('error', { message: 'Game already started' });
      return;
    }
    
    const player = {
      id: socket.id,
      name: playerName,
      lockedScore: 0,
      bankedThisRound: false,
      eliminated: false,
      turnOrder: room.players.length
    };
    
    room.players.push(player);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    io.to(roomCode).emit('game_state_update', room);
  });
  
  // Start game
  socket.on('start_game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    saveHistory(room);
    room.gameState.status = 'playing';
    room.gameState.currentRound = 1;
    room.gameState.roundActive = true;
    room.gameState.sharedRoundScore = 0;
    room.gameState.rollCount = 0;
    room.gameState.currentTurnIndex = 0;
    
    // Reset all players
    room.players.forEach(p => {
      p.bankedThisRound = false;
      p.eliminated = false;
    });
    
    io.to(socket.roomCode).emit('game_state_update', room);
  });
  
  // Roll dice
  socket.on('roll_dice', ({ die1, die2 }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.gameState.status !== 'playing') return;
    
    const currentPlayer = room.players[room.gameState.currentTurnIndex];
    if (currentPlayer.id !== socket.id) {
      socket.emit('error', { message: 'Not your turn' });
      return;
    }
    
    if (!room.gameState.roundActive) {
      socket.emit('error', { message: 'Round is over' });
      return;
    }
    
    saveHistory(room);
    
    const { newScore, roundDead } = processDiceRoll(room, die1, die2);
    
    room.gameState.sharedRoundScore = newScore;
    room.gameState.rollCount++;
    
    if (roundDead) {
      room.gameState.roundActive = false;
      // Everyone who hasn't banked gets 0
      room.players.forEach(p => {
        if (p.bankedThisRound) {
          p.lockedScore += room.gameState.sharedRoundScore;
        }
      });
    }
    
    io.to(socket.roomCode).emit('game_state_update', room);
  });
  
  // Bank
  socket.on('bank', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.gameState.status !== 'playing') return;
    if (!room.gameState.roundActive) return;
    if (room.gameState.rollCount < 3) {
      socket.emit('error', { message: 'Cannot bank in first 3 rolls' });
      return;
    }
    
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.bankedThisRound) return;
    
    saveHistory(room);
    player.bankedThisRound = true;
    
    io.to(socket.roomCode).emit('game_state_update', room);
  });
  
  // Next turn (host only)
  socket.on('next_turn', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    saveHistory(room);
    
    // If round is dead or all players banked, end round
    const allBanked = room.players.every(p => p.bankedThisRound);
    
    if (!room.gameState.roundActive || allBanked) {
      // End round, lock scores
      room.players.forEach(p => {
        if (p.bankedThisRound && room.gameState.roundActive) {
          p.lockedScore += room.gameState.sharedRoundScore;
        }
        p.bankedThisRound = false;
      });
      
      // Start next round
      if (room.gameState.currentRound < room.gameState.totalRounds) {
        room.gameState.currentRound++;
        room.gameState.roundActive = true;
        room.gameState.sharedRoundScore = 0;
        room.gameState.rollCount = 0;
        room.gameState.currentTurnIndex = 0;
      } else {
        room.gameState.status = 'finished';
      }
    } else {
      // Just move to next player
      room.gameState.currentTurnIndex = 
        (room.gameState.currentTurnIndex + 1) % room.players.length;
    }
    
    io.to(socket.roomCode).emit('game_state_update', room);
  });
  
  // Undo (host only)
  socket.on('undo', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.history.length === 0) return;
    
    const previousState = room.history.pop();
    room.players = previousState.players;
    room.gameState = previousState.gameState;
    
    io.to(socket.roomCode).emit('game_state_update', room);
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    
    // Remove player
    room.players = room.players.filter(p => p.id !== socket.id);
    
    // If host left and players remain, assign new host
    if (room.hostId === socket.id && room.players.length > 0) {
      room.hostId = room.players[0].id;
    }
    
    // If no players, delete room
    if (room.players.length === 0) {
      rooms.delete(socket.roomCode);
    } else {
      io.to(socket.roomCode).emit('game_state_update', room);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
