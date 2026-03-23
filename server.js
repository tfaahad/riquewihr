const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Hardcoded MongoDB Connection
const MONGODB_URI = 'mongodb+srv://tfaahad:PQp8HXCFtM0cSTcR@cluster0.bg2zfbj.mongodb.net/Riquewihr?retryWrites=true&w=majority';


// Cloudinary Configuration
cloudinary.config({
  cloud_name: 'daflonltx',  // Replace with your actual cloud name
  api_key: '424622119353354',         // Replace with your actual API key
  api_secret: 'qgeT18_LsLzo_MOrPXGckip64AE'    // Replace with your actual API secret
});

const mongooseOptions = {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
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
  text: { type: String, default: '' },
  imageUrl: { type: String, default: null },
  imagePublicId: { type: String, default: null },
  timestamp: { type: Date, default: Date.now },
  reactions: {
    type: Map,
    of: String,
    default: {}
  }
}));

// API route to fetch messages with pagination
app.get('/messages', async (req, res) => {
  try {
    const before = req.query.before ? new Date(req.query.before) : new Date();
    const limit = parseInt(req.query.limit) || 50;

    const messages = await Message.find({ timestamp: { $lt: before } })
      .sort({ timestamp: -1 })
      .limit(limit);

    res.json(messages.reverse());
  } catch (err) {
    console.error('Pagination error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Track active users
let activeUsers = new Map();

// Socket.IO
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Send latest 50 messages when user connects
  Message.find().sort({ timestamp: -1 }).limit(50)
    .then(messages => {
      const msgs = messages.map(m => {
        const msgObj = m.toObject();
        msgObj.reactions = Object.fromEntries(m.reactions);
        return msgObj;
      });
      socket.emit('previous messages', msgs.reverse());
    })
    .catch(err => console.error('Fetch messages error:', err));

  // Send current active users to the new user
  socket.emit('active:users', Array.from(activeUsers.values()));
  
  // Handle username setting
  socket.on('set username', (username) => {
    if (username) {
      activeUsers.set(socket.id, username);
      io.emit('active:users', Array.from(activeUsers.values()));
    }
  });

  // Handle new messages
  socket.on('chat message', async (msg) => {
    if (!msg.name || !msg.text) return;
    
    try {
      await new Message(msg).save();
      io.emit('chat message', msg);
    } catch (err) {
      console.error('Save message error:', err);
    }
  });

    // Handle image messages with Cloudinary upload
  socket.on('chat image', async (msg) => {
    if (!msg.name || !msg.imageData) return;
    
    try {
      // Upload to Cloudinary
      const result = await cloudinary.uploader.upload(msg.imageData, {
        folder: 'chat_images',
        transformation: [
          { width: 800, height: 800, crop: 'limit' },
          { quality: 'auto' }
        ]
      });
      
      // Save to database with Cloudinary URL
      const newMessage = new Message({
        name: msg.name,
        text: msg.text || '',
        imageUrl: result.secure_url,
        imagePublicId: result.public_id
      });
      await newMessage.save();
      
      const msgToSend = newMessage.toObject();
      msgToSend.reactions = Object.fromEntries(newMessage.reactions);
      io.emit('chat image', msgToSend);
    } catch (err) {
      console.error('Save image message error:', err);
    }
  });

  // Typing indicators
  socket.on('typing:start', ({ user }) => {
    socket.broadcast.emit('typing:start', { user });
  });

  socket.on('typing:stop', ({ user }) => {
    socket.broadcast.emit('typing:stop', { user });
  });

  // Handle reactions
  const ALLOWED_EMOJIS = new Set(['❤️','🙄','😂','😔','😢','😭']);

  socket.on('reaction:set', async ({ messageId, user, emoji }) => {
    if (!ALLOWED_EMOJIS.has(emoji)) return;

    try {
      const updated = await Message.findByIdAndUpdate(
        messageId,
        { $set: { [`reactions.${user}`]: emoji } },
        { new: true }
      );

      if (updated) {
        io.emit('reaction:updated', {
          messageId,
          reactions: Object.fromEntries(updated.reactions)
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
          reactions: Object.fromEntries(updated.reactions)
        });
      }
    } catch (error) {
      console.error('Error clearing reaction:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    activeUsers.delete(socket.id);
    io.emit('active:users', Array.from(activeUsers.values()));
  });
});

// Health check route
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