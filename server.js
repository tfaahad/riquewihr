const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",  // Allow all origins (update in production)
    methods: ["GET", "POST"]
  }
});
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Hardcoded MongoDB Connection (no .env)
const MONGODB_URI = 'mongodb+srv://tfaahad:PQp8HXCFtM0cSTcR@cluster0.bg2zfbj.mongodb.net/Riquewihr?retryWrites=true&w=majority';

const mongooseOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000,  // 30 seconds
  socketTimeoutMS: 45000,          // 45 seconds
  retryWrites: true,
  w: 'majority'
};

// Connect to MongoDB with automatic retries
const connectDB = () => {
  mongoose.connect(MONGODB_URI, mongooseOptions)
    .then(() => console.log('MongoDB connected'))
    .catch(err => {
      console.error('MongoDB connection failed:', err.message);
      console.log('Retrying in 5 seconds...');
      setTimeout(connectDB, 5000);
    });
};
connectDB();

// Database event listeners
mongoose.connection.on('connected', () => console.log('Mongoose connected'));
mongoose.connection.on('error', err => console.error('Mongoose error:', err));
mongoose.connection.on('disconnected', () => console.log('Mongoose disconnected'));

// Message Model
const Message = mongoose.model('Message', new mongoose.Schema({
  name: String,
  text: String,
  timestamp: { type: Date, default: Date.now },
  reactions: {
    type: Map, // key: username, value: emoji
    of: String,
    default: {}
  }
}));




// API route to fetch messages with pagination
app.get('/messages', async (req, res) => {
  try {
    // client can send ?before=timestamp&limit=50
    const before = req.query.before ? new Date(req.query.before) : new Date();
    const limit = parseInt(req.query.limit) || 50;

    // fetch messages older than "before"
    const messages = await Message.find({ timestamp: { $lt: before } })
      .sort({ timestamp: -1 }) // newest first
      .limit(limit);

    // return messages in ascending order (oldest first for display)
    res.json(messages.reverse());
  } catch (err) {
    console.error('Pagination error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});


// Socket.IO with error handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Send latest 50 messages when user connects
Message.find().sort({ timestamp: -1 }).limit(50)
  .then(messages => {
    // Convert Map to plain object for each message
    const msgs = messages.map(m => {
      const msgObj = m.toObject();
      msgObj.reactions = Object.fromEntries(m.reactions);
      return msgObj;
    });
    socket.emit('previous messages', msgs.reverse());
  })
  .catch(err => console.error('Fetch messages error:', err));



  // Handle new messages
  socket.on('chat message', async (msg) => {
    if (!msg.name || !msg.text) return;
    
    try {
  await new Message(msg).save();



  io.emit('chat message', msg);  // Broadcast to all
} catch (err) {
  console.error('Save message error:', err);
}
  });


  // Handle reactions
  const ALLOWED_EMOJIS = new Set(['❤️','🙄','😂','😔','😢','😭']);

  socket.on('reaction:set', async ({ messageId, user, emoji }) => {
  if (!['❤️', '🙄', '😂', '😔', '😢','😭'].includes(emoji)) return;

  try {
    const updated = await Message.findByIdAndUpdate(
      messageId,
      { $set: { [`reactions.${user}`]: emoji } },
      { new: true }
    );

    if (updated) {
      io.emit('reaction:updated', {
        messageId,
        reactions: Object.fromEntries(updated.reactions) // ✅ changed
      });
    }
  } catch (error) {
    console.error('Error setting reaction:', error);
  }
});

// Reaction: Clear
socket.on('reaction:clear', async ({ messageId, user }) => {
  try {
    const updated = await Message.findByIdAndUpdate(
      messageId,
      { $unset: { [`reactions.${user}`]: "" } },
      { new: true }
    );

    if (updated) {
      io.emit('reaction:updated', {
        messageId,
        reactions: Object.fromEntries(updated.reactions) // ✅ changed
      });
    }
  } catch (error) {
    console.error('Error clearing reaction:', error);
  }
});


  socket.on('disconnect', () => console.log('User disconnected:', socket.id));
});





// Health check route (required for Render)
app.get('/health', (req, res) => res.sendStatus(200));

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

// Crash prevention
process.on('uncaughtException', err => console.error('Crash prevented:', err));