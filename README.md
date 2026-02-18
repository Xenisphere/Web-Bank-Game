# Bank - Dice Game

A real-time multiplayer dice game where players compete to score the most points over multiple rounds.

**Play now:** [https://bank-gambit.onrender.com](https://bank-gambit.onrender.com)

> **Note:** The server spins down after inactivity. First load may take 30-60 seconds to boot up.

## How to Play

### Setup
- One player creates a room and shares the 4-letter code
- Other players join using the code
- Host sets number of rounds (default: 20) and starts the game

### Game Rules

**First 3 Rolls:**
- Roll 7 = +70 points
- Any other total = +that number

**After 3 Rolls:**
- Roll 7 = Round dies, score goes to 0
- Roll doubles = Score ×2
- Any other total = +that number
- Snake eyes (2) and boxcars (12) are blocked

### Banking
- After 3+ rolls, you can **bank** to lock in the shared score
- Once banked, you're safe for that round
- If someone rolls a 7, non-banked players get 0

**Highest total after all rounds wins!**

## Tech Stack

- Node.js + Express
- Socket.IO for real-time multiplayer
- Vanilla JavaScript (no framework)
- Claude AI was used to create the code
