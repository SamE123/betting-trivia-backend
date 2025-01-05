  /*******************************************************************
   * server.js (Node/Express)
   *******************************************************************/
  const express = require('express');
  const cors = require('cors');
  const fs = require('fs');
  const csvParser = require('csv-parser');
  const app = express();

  app.use(cors({
    origin: 'https://same123.github.io',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  }));
  app.use(express.json());

  //=============================
  //    Global Game State
  //=============================
  let players = [];
  let questions = [];
  let questionIndex = 0;
  let gameStarted = false;
  let currentQuestion = null;
  let winner = null;
  let host = null;
  let isEliminationPhase = false;
  let skipFirstElimination = false; 
  let systemMessage = 'Welcome to All-In Trivia.'; // Default message
  let categories = [];
  let subcategories = [];
  let globalSubcategories = [];
  let globalCategories = []
  let globalPhaseThreshold = 50;
  let isBroadcasting = false;
  let newQuestion = false; 
  let previousCategories = [];
  let previousSubcategories = [];


  // SSE tracking
  let sseClients = {};  
  // We'll store them as sseClients[playerName] = res

  // Timer variables
  let timeRemaining = 0;
  let stakeRemaining = 100;
  let globalIntervalId = null;

  //=============================
  //    SSE: Broadcast
  //=============================
  function broadcastGameState() {
    if (isBroadcasting) {
        console.warn("Broadcast already in progress. Skipping this broadcast.");
        return;
    }
    isBroadcasting = true;

    const gameState = {
        players: players.map((player) => ({
            ...player,
            answer: player.answer !== undefined && timeRemaining > 0 ? "Answered" : player.answer,
            eliminated: player.eliminated,
        })),
        questionsLoaded: questions.length > 0,
        questionIndex,
        isEliminationPhase,
        currentQuestion,
        gameStarted,
        winner,
        host,
        timeRemaining,
        stakeRemaining,
        systemMessage,
        newQuestion,
    };

    const data = JSON.stringify(gameState);

    try {
        Object.values(sseClients).forEach((res) => {
            res.write(`data: ${data}\n\n`);
        });

        scoreboardClients.forEach((res) => {
            res.write(`data: ${data}\n\n`);
        });
    } finally {
        isBroadcasting = false;
    }
}
  
        //=============================
  //    Start the "Global" Timer
  //=============================
  // We'll keep stake at 100 for the first ~2s (2000ms).
  function startGlobalInterval() {
    if (globalIntervalId) {
      clearInterval(globalIntervalId);
    }

    let elapsedMs = 0;
    globalIntervalId = setInterval(() => {
      elapsedMs += 100;

      // Decrement TIME every 1 second
      if (elapsedMs % 1000 === 0) {
        timeRemaining--;
        if (timeRemaining < 0) {
          finalizeQuestion();
        }
      }

      // Keep stake at 100 for first 2s, then decrement to 25
      if (elapsedMs >= 2000 && stakeRemaining > 25) {
        stakeRemaining--;
      }

      broadcastGameState();
    }, 100);
  }

  function stopGlobalInterval() {
    if (globalIntervalId) {
      clearInterval(globalIntervalId);
      globalIntervalId = null;
    }
  }

  //=============================
  //    Finalize & Next Question
  //=============================
  function finalizeQuestion() {
    // Score everyone (only if they're not eliminated)
    players.forEach((player) => {
      if (!player.eliminated) {
        if (player.answer === undefined) {
          player.answer = 'No Answer';
          player.stake = 25;
        }
        scorePlayer(player, currentQuestion?.correct);
      }
    });
  
    const alivePlayers = players.filter((p) => !p.eliminated);
    const anyPlayerOverThreshold = alivePlayers.some((p) => p.score > globalPhaseThreshold);
  
    // Check if elimination phase should begin
    if (!isEliminationPhase && anyPlayerOverThreshold && alivePlayers.length > 1) {
      console.log(`At least one player passed ${globalPhaseThreshold}. Entering ELIMINATION MODE.`);
      systemMessage = 'The player with the lowest score will be eliminated after this round.';
      isEliminationPhase = true;
      skipFirstElimination = true; // Skip the first elimination
    }
  
    newQuestion = true;
    broadcastGameState();
    newQuestion = false;

  
    setTimeout(() => {
      // If in elimination phase, handle elimination logic
      if (isEliminationPhase && alivePlayers.length > 1) {
        if (skipFirstElimination) {
          // Skip the first elimination in elimination phase
          console.log('Skipping elimination for this round (first round in elimination phase).');
          skipFirstElimination = false; // Reset after skipping
        } else {
          // Perform elimination
          console.log('Elimination phase is active. Eliminating the lowest scorer...');
          eliminateLowestScorer();
        }
      }
  
      // Check for a winner after potential elimination
      checkForLastPlayerStanding();
      if (winner) {
        stopGlobalInterval();
        return;
      }
  
      // Move to the next question
      nextQuestion();
    }, 3000);
  
    stopGlobalInterval();
  }

  function eliminateLowestScorer() {
    // Only consider players who are NOT eliminated and answered incorrectly
    const incorrectPlayers = players.filter((p) => !p.eliminated && p.correct === false);
  
    if (incorrectPlayers.length === 0) {
      console.log('No players answered incorrectly. No one is eliminated.');
      systemMessage = 'No players answered incorrectly. No elimination this round.';
      broadcastGameState();
      return;
    }
  
    // Find the minimum score among players who answered incorrectly
    const minScore = Math.min(...incorrectPlayers.map((p) => p.score));
  
    // Find all players with that minimum score
    const lowestScorers = incorrectPlayers.filter((p) => p.score === minScore);
  
    // If all incorrect players are tied at the lowest score, skip elimination
    if (lowestScorers.length === incorrectPlayers.length && incorrectPlayers.length == this.alivePlayers.length) {
      console.log('All incorrect players are tied for the lowest score. No one is eliminated.');
      systemMessage = 'All incorrect players are tied for the lowest score. No elimination this round.';
      broadcastGameState();
      return;
    }
  
    // Eliminate all players tied for the lowest score among incorrect answers
    lowestScorers.forEach((player) => {
      player.eliminated = true;
      systemMessage = `${player.name} had the lowest score of those who answered wrong! ${player.name} has been eliminated.`;
      console.log(`Eliminated player: ${player.name} (score: ${player.score})`);
    });
  
    broadcastGameState();
  }
  

  function checkForLastPlayerStanding() {
    const alivePlayers = players.filter((p) => !p.eliminated);
  
    if (alivePlayers.length === 1) {
      // Declare the winner
      winner = alivePlayers[0].name;
      console.log(`Winner is: ${winner}`);
      systemMessage = 'Game over. Play again?';
      isEliminationPhase = false; 
      gameStarted = false; 
      broadcastGameState(); // Ensure winning state is broadcast
    } else {
      winner = null; // Reset winner if multiple players still alive
    }
  }
  
  
  
  
  function nextQuestion() {
    questionIndex++;
    if (questionIndex >= questions.length) {
      questionIndex = 0; // or end the game
    }

    console.log("Asking question at index...");
    console.log(questionIndex);

    currentQuestion = questions[questionIndex];
    players.forEach((p) => {
      p.answer = undefined;
      p.stake = undefined;
      p.correct = undefined;
    });

    timeRemaining = 10;
    stakeRemaining = 100;
    startGlobalInterval();
    broadcastGameState();
  }

  //=============================
  //    Score a Single Player
  //=============================
  function scorePlayer(player, correctAnswer) {
    const bet = (player.stake !== undefined) ? player.stake : 100;
    const betFraction = bet / 100;

    if (player.answer === correctAnswer) {
      const pointsEarned = Math.ceil(player.score * betFraction);
      player.score += pointsEarned;
      player.correct = true;
    } else {
      const pointsLost = Math.ceil(player.score * betFraction);
      player.score -= pointsLost;
      if (player.score < 1) {
        player.score = 1;
      }
      player.correct = false;
    }
  }



  //=============================
  //    Reassign Host
  //=============================
  function reassignHost() {
    if (players.length === 0) {
      host = null;
      return;
    }
    // Find the earliest joinTime
    players.sort((a, b) => a.joinTime - b.joinTime);
    players[0].isHost = true; 
    host = players[0].name;
  }

  //=============================
  //    CSV Loading
  //=============================
  function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  app.post('/load-questions', (req, res) => {
    console.log("Loading questions...")
    const questionsFilePath = './data/questions.csv'; // Path to the CSV file
    const loadedQuestions = [];
  
    fs.createReadStream(questionsFilePath)
      .pipe(csvParser())
      .on('data', (row) => {
        try {
          const answers = [
            row['Correct Answer'],
            row['Answer2'],
            row['Answer3'],
            row['Answer4']
          ];
          const correctAnswer = answers[0];
          shuffleArray(answers); // Shuffle answers to randomize order
  
          // Push a question object with all required properties
          loadedQuestions.push({
            caption: row['Question'],
            image: row['Img'],
            answers, // Shuffled answers
            correct: correctAnswer,
            subcategory: row['Subcategory'],
            category: row['Category'],
            difficulty: row['Difficulty']
          });
        } catch (err) {
          console.error('Error parsing row:', err);
        }
      })
      .on('end', () => {
        questions = loadedQuestions; // Update global questions array
  
        // Optionally, filter questions based on host settings if applied
        if (globalCategories?.length > 0 || globalSubcategories?.length > 0) {
          questions = questions.filter((q) =>
            (globalCategories.includes(q.category) || globalSubcategories.includes(q.subcategory))
          );
        }
  
        shuffleArray(questions); // Shuffle questions for random order
        broadcastGameState(); // Notify all clients of the updated game state
        res.json({ message: 'Questions loaded successfully', questions });
      })
      .on('error', (err) => {
        console.error('Error reading file:', err);
        res.status(500).json({ error: 'Error loading questions' });
      });

      questionIndex = 0;

  });

  //=============================
  //    Start Game
  //=============================
  app.post('/start-game', (req, res) => {
    console.log("Starting game started");
  
    const { playerName } = req.body;
    const player = players.find((p) => p.name === playerName);
    if (!player || !player.isHost) {
      return res.status(403).json({ error: 'Only the host can start the game' });
    }
    if (questions.length === 0) {
      return res.status(400).json({ error: 'No questions loaded.' });
    }
  
    players.forEach((p) => {
      p.answer = undefined;
      p.stake = undefined;
      p.correct = undefined;
    });

    console.log("Starting game with questionIndex of...");
    console.log(questionIndex);
  
    winner = null;
    currentQuestion = questions[questionIndex];
    timeRemaining = 10;
    stakeRemaining = 100;
    systemMessage = `After a player reaches ${globalPhaseThreshold}, sudden death will begin.`

  
    // Pause for 1 second before starting the game
    setTimeout(() => {
      gameStarted = true;
      startGlobalInterval(); // Start the timer after the pause
      console.log("Starting game finished");
      res.json({ message: 'Game started', currentQuestion });
    }, 1000); // 1000 ms pause
  });
  

  //=============================
  //    SSE Connection
  //=============================
  // We track who is connecting by a path param: /events/:playerName
  app.get('/events/:playerName', (req, res) => {
    const { playerName } = req.params;

    // Let's store this SSE connection by playerName
    sseClients[playerName] = res;

    // SSE Headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // If the SSE connection closes, remove the player
    req.on('close', () => {
      delete sseClients[playerName];
      // Also remove the player from our 'players' array if they exist
      const idx = players.findIndex((p) => p.name === playerName);
      if (idx !== -1) {
        // Was this the host?
        const leavingPlayer = players[idx];
        const wasHost = leavingPlayer.isHost;

        players.splice(idx, 1); // remove them

        if (wasHost) {
          // reassign host if we still have players
          reassignHost();
        }

        broadcastGameState();
      }
    });

    // Immediately send them the current game state
    broadcastGameState();
  });

  //=============================
  //    Choose Answer
  //=============================
  app.post('/choose-answer', (req, res) => {

    console.log("answer received")
    console.log("answer is...")
    console.log(req.body)

    const { playerName, stake, answer } = req.body;
    const player = players.find((p) => p.name === playerName);
  
    if (!player) {
      return res.status(404).send('Player not found');
    }
    if (player.eliminated) {
      return;
     // return res.status(403).json({ error: 'You have been eliminated and cannot answer.' });
    }
  
    // If not eliminated, record the answer
    player.stake = stake;
    player.answer = answer;
    player.correct = undefined;
  
    broadcastGameState();
    res.json({ message: 'Answer recorded' });
  });
  
  //=============================
  //    Add Player
  //=============================
  app.post('/add-player', (req, res) => {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Player name is required' });
    }
  
    // Prevent new players from joining during the elimination phase
    if (isEliminationPhase) {
      return res.status(403).json({ error: 'Cannot join during the elimination phase.' });
    }
  
    // Check if the room is full (8 players)
    const activePlayersCount = players.length;
    if (activePlayersCount >= 8) {
      return res.status(403).json({ error: 'Room is full. Maximum of 8 players allowed.' });
    }
  
    const existingPlayer = players.find((p) => p.name === name);
    if (existingPlayer) {
      return res.status(409).json({ error: 'Player already exists' });
    }
  
    const isHost = (players.length === 0);
    const newPlayer = {
      name,
      score: 4,
      isHost,
      joinTime: Date.now(),
      eliminated: false,     
      role: 'player', // All players are active; no spectators
    };
    players.push(newPlayer);
    
    if (isHost) {
      host = newPlayer.name;
    }
  
    broadcastGameState();
    res.status(201).json(newPlayer);
  });
  
  //=============================
  //    Start the Server
  //=============================
  app.listen(3000, () => {
    console.log('Backend server running at http://localhost:3000');
  });

  let scoreboardClients = [];

app.get('/scoreboard', (req, res) => {
  // We set up a separate SSE for the scoreboard
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  scoreboardClients.push(res);

  // If the scoreboard SSE closes, just remove it from the scoreboardClients list
  req.on('close', () => {
    scoreboardClients = scoreboardClients.filter((client) => client !== res);
  });

  // Immediately send them the scoreboard
  sendScoreboard();
});

app.post('/update-settings', (req, res) => {
  const { phaseThreshold, selectedCategories, selectedSubcategories } = req.body;

  // Update global settings
  globalPhaseThreshold = phaseThreshold || globalPhaseThreshold;
  globalCategories = selectedCategories || [];
  globalSubcategories = selectedSubcategories || [];

  console.log('Settings update received:', {
    phaseThreshold: globalPhaseThreshold,
    selectedCategories: globalCategories,
    selectedSubcategories: globalSubcategories,
  });

  // Compare previous categories and subcategories with the new ones
  const categoriesChanged = JSON.stringify(previousCategories) !== JSON.stringify(globalCategories);
  const subcategoriesChanged = JSON.stringify(previousSubcategories) !== JSON.stringify(globalSubcategories);

  if (categoriesChanged || subcategoriesChanged) {
    console.log('Categories or subcategories have changed. Reloading questions...');
    
    // Reload questions if there's a change in categories/subcategories
    const questionsFilePath = './data/questions.csv'; // Path to the CSV file
    const loadedQuestions = [];

    fs.createReadStream(questionsFilePath)
      .pipe(csvParser())
      .on('data', (row) => {
        try {
          const answers = [
            row['Correct Answer'],
            row['Answer2'],
            row['Answer3'],
            row['Answer4']
          ];
          const correctAnswer = answers[0];
          shuffleArray(answers); // Shuffle answers to randomize order

          // Push a question object with all required properties
          loadedQuestions.push({
            caption: row['Question'],
            image: row['Img'],
            answers, // Shuffled answers
            correct: correctAnswer,
            subcategory: row['Subcategory'],
            category: row['Category'],
            difficulty: row['Difficulty']
          });
        } catch (err) {
          console.error('Error parsing row:', err);
        }
      })
      .on('end', () => {
        questions = loadedQuestions; // Update global questions array

        // Filter questions based on host settings if applied
        if (globalCategories?.length > 0 || globalSubcategories?.length > 0) {
          questions = questions.filter((q) =>
            (globalCategories.includes(q.category) || globalSubcategories.includes(q.subcategory))
          );
        }

        shuffleArray(questions); // Shuffle questions for random order

        // Update the previous values **after** loading
        previousCategories = [...globalCategories]; 
        previousSubcategories = [...globalSubcategories];

        broadcastGameState(); // Notify all clients of the updated game state
        res.json({ message: 'Questions loaded successfully', questions });
      })
      .on('error', (err) => {
        console.error('Error reading file:', err);
        res.status(500).json({ error: 'Error loading questions' });
      });

      questionIndex = 0;


  } else {
    console.log('Categories and subcategories unchanged. Skipping reload.');
    res.json({ message: 'Settings updated successfully, but questions remain unchanged.' });
  }

  systemMessage = `After a player reaches ${globalPhaseThreshold}, sudden death will begin.`;
  broadcastGameState(); // Always broadcast updated settings
});


function sendScoreboard() {
  const scoreboardData = {
    players: players.map((player) => ({
      ...player,
      // If the player has answered, mask it as "Answered" until time runs out
      answer: player.answer !== undefined && timeRemaining > 0
        ? "Answered"
        : player.answer,
    })),
    gameStarted,
    currentQuestion,
    winner,
    host,
    timeRemaining,
    stakeRemaining,
  };

  const data = JSON.stringify(scoreboardData);

  scoreboardClients.forEach((res) => {
    res.write(`data: ${data}\n\n`);
  });
}
  

  app.get('/load-categories', (req, res) => {
    const questionsFilePath = './data/questions.csv'; // Path to the CSV file
    const allCategories = new Set();
    const allSubcategories = new Set();
  
    fs.createReadStream(questionsFilePath)
      .pipe(csvParser({
        mapHeaders: ({ header }) => header.trim() // Normalize headers
      }))
      .on('data', (row) => {
        console.log('Row Data:', row); // Debug full row to verify keys
        try {
          if (row['Category']?.trim()) {
            console.log('entered category if statement');
            allCategories.add(row['Category'].trim());
            console.log('categories:', Array.from(allCategories));
          }
          if (row['Subcategory']?.trim()) {
            console.log('entered subcategory if statement');
            allSubcategories.add(row['Subcategory'].trim());
            console.log('subcat:', Array.from(allSubcategories));
          }
        } catch (err) {
          console.error('Error parsing row for categories:', err);
        }
      })
      .on('end', () => {
        console.log("All loading categories complete");
        const categories = Array.from(allCategories);
        const subcategories = Array.from(allSubcategories);
        res.json({ categories, subcategories });
      })
      .on('error', (err) => {
        console.error('Error reading file for categories:', err);
        res.status(500).json({ error: 'Error loading categories' });
      });
  });

  app.post('/reset-game', (req, res) => {
    // Reset global game state
    
    console.log("Resetting game");
    console.log("Question index is...");
    console.log(questionIndex);
    this.questionIndex = questionIndex+1;

    players.forEach((player) => {
      player.score = 4; // Reset score to default
      player.eliminated = false; // Make all players active
    });
  
    gameStarted = false;
    currentQuestion = null;
    winner = null;
    isEliminationPhase = false;
    skipFirstElimination = false;
    currentQuestion = null; 
    newQuestion = false; 
    systemMessage = `After a player reaches ${globalPhaseThreshold}, sudden death will begin.`

  
    console.log("Resetting game finished");
    res.json({ message: 'Game reset.' });


});
  
