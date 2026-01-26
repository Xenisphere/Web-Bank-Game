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
    currentTurnIndex: 0,
    lastRoll: null
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

// Helper: Start new round
function startNewRound(room) {
  // Reset all players
  room.players.forEach(p => {
    p.bankedThisRound = false;
    p.usePhysicalDice = false;
  });
  
  // Increment round
  room.gameState.currentRound++;
  room.gameState.roundActive = true;
  room.gameState.sharedRoundScore = 0;
  room.gameState.rollCount = 0;
  room.gameState.lastRoll = null;
  
  // Advance to next player (don't reset to 0)
  room.gameState.currentTurnIndex = 
    (room.gameState.currentTurnIndex + 1) % room.players.length;
}

// Helper: Advance to next turn (skip banked players)
function advanceTurn(room) {
  const startIndex = room.gameState.currentTurnIndex;
  let nextIndex = (startIndex + 1) % room.players.length;
  
  // Keep advancing until we find a player who hasn't banked
  // or we've checked everyone
  let attempts = 0;
  while (room.players[nextIndex].bankedThisRound && attempts < room.players.length) {
    nextIndex = (nextIndex + 1) % room.players.length;
    attempts++;
  }
  
  room.gameState.currentTurnIndex = nextIndex;
  
  // If everyone has banked, end the round
  if (room.players.every(p => p.bankedThisRound)) {
    room.gameState.roundActive = false;
  }
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
        turnOrder: 0,
        usePhysicalDice: false
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
      turnOrder: room.players.length,
      usePhysicalDice: false
    };
    
    room.players.push(player);
    socket.join(roomCode);
    socket.roomCode = roomCode;
    
    io.to(roomCode).emit('game_state_update', room);
  });
  
  // Set total rounds
  socket.on('set_rounds', ({ totalRounds }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id || room.gameState.status !== 'waiting') return;
    
    room.gameState.totalRounds = totalRounds;
    io.to(socket.roomCode).emit('game_state_update', room);
  });
  
  // Start game
  socket.on('start_game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    saveHistory(room);
    room.gameState.status = 'playing';
    startNewRound(room);
    
    io.to(socket.roomCode).emit('game_state_update', room);
  });
  
  // Roll dice (virtual)
  socket.on('roll_dice', () => {
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
    
    // Roll two dice
    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;
    const total = die1 + die2;
    
    // Store the roll
    room.gameState.lastRoll = { die1, die2, total };
    
    const { newScore, roundDead } = processDiceRoll(room, die1, die2);
    
    room.gameState.sharedRoundScore = newScore;
    room.gameState.rollCount++;
    
    if (roundDead) {
      room.gameState.roundActive = false;
      // Everyone who banked gets their score (will be 0 since round died)
      room.players.forEach(p => {
        if (p.bankedThisRound) {
          p.lockedScore += newScore;
        }
      });
      
      // Don't auto-advance turn when round dies
      // The next round will start from player 1
    } else {
      // Auto-advance to next turn
      advanceTurn(room);
    }
    
    io.to(socket.roomCode).emit('game_state_update', room);
  });
  
  // Submit physical dice
  socket.on('submit_physical_dice', ({ value, isDoubles }) => {
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
    
    // Mark player as using physical dice
    currentPlayer.usePhysicalDice = true;
    
    // Store the roll (for physical dice, we don't know individual die values for non-doubles)
    if (isDoubles) {
      const dieValue = value / 2;
      room.gameState.lastRoll = { die1: dieValue, die2: dieValue, total: value };
    } else {
      room.gameState.lastRoll = { die1: null, die2: null, total: value };
    }
    
    const { rollCount, sharedRoundScore } = room.gameState;
    let newScore = sharedRoundScore;
    let roundDead = false;
    
    if (rollCount < 3) {
      // First 3 rolls: value is 2-12
      if (value === 7) {
        newScore += 70;
      } else {
        newScore += value;
      }
    } else {
      // After 3 rolls
      if (value === 7) {
        roundDead = true;
        newScore = 0;
      } else if (isDoubles) {
        newScore *= 2;
      } else {
        newScore += value;
      }
    }
    
    room.gameState.sharedRoundScore = newScore;
    room.gameState.rollCount++;
    
    if (roundDead) {
      room.gameState.roundActive = false;
      // Everyone who banked gets their score (will be 0)
      room.players.forEach(p => {
        if (p.bankedThisRound) {
          p.lockedScore += newScore;
        }
      });
      
      // Don't auto-advance turn when round dies
      // The next round will start from player 1
    } else {
      // Auto-advance to next turn
      advanceTurn(room);
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
    
    // Add current round score to locked score
    player.lockedScore += room.gameState.sharedRoundScore;
    player.bankedThisRound = true;
    
    // Check if all players have banked
    if (room.players.every(p => p.bankedThisRound)) {
      room.gameState.roundActive = false;
      
      // Auto-advance to next round after brief delay
      setTimeout(() => {
        if (room.gameState.currentRound < room.gameState.totalRounds) {
          startNewRound(room);
          io.to(socket.roomCode).emit('game_state_update', room);
        } else {
          room.gameState.status = 'finished';
          io.to(socket.roomCode).emit('game_state_update', room);
        }
      }, 2000);
    } else {
      // If the current turn player just banked, advance to next non-banked player
      const currentPlayer = room.players[room.gameState.currentTurnIndex];
      if (currentPlayer.id === socket.id) {
        advanceTurn(room);
      }
    }
    
    io.to(socket.roomCode).emit('game_state_update', room);
  });
  
  // Next turn (host only)
  socket.on('next_turn', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    saveHistory(room);
    
    // If round is dead or all players banked, end round and start new one
    const allBanked = room.players.every(p => p.bankedThisRound);
    
    if (!room.gameState.roundActive || allBanked) {
      // End round, lock scores for those who haven't banked yet
      room.players.forEach(p => {
        if (!p.bankedThisRound && room.gameState.roundActive) {
          // They didn't bank, so they get the current score
          p.lockedScore += room.gameState.sharedRoundScore;
        }
      });
      
      // Start next round or end game
      if (room.gameState.currentRound < room.gameState.totalRounds) {
        startNewRound(room);
      } else {
        room.gameState.status = 'finished';
      }
    } else {
      // Just move to next player
      advanceTurn(room);
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
