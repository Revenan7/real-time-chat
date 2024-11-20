const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  },
});

// Подключение к Redis
const redis = new Redis({
  host: "localhost",
  port: 6379,
});


// Подключение к MongoDB
mongoose.connect("mongodb://localhost:27017/chat", {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const chatSchema = new mongoose.Schema({
  chatId: String,
  name: String, // Имя чата
  messages: [
    {
      sender: String,
      message: String,
      timestamp: { type: Date, default: Date.now },
    },
  ],
});

const Chat = mongoose.model("Chat", chatSchema);

io.on("connection", (socket) => {
  console.log("Новое соединение:", socket.id);

  socket.on("create_chat", async (chatName) => {
    const chatId = new mongoose.Types.ObjectId().toString();
    console.log(`Создан новый чат с ID: ${chatId} и именем: ${chatName}`);

    await redis.lpush("recent_chats", chatId);
    await redis.ltrim("recent_chats", 0, 4);

    const newChat = new Chat({ chatId, name: chatName, messages: [] });
    try {
      await newChat.save();

      socket.emit("chat_created", { chatId, name: chatName });

      const allChats = await Chat.find();
      const allChatsList = allChats.map((chat) => ({
        chatId: chat.chatId,
        name: chat.name,
      }));

      io.emit("all_chats", allChatsList);

      const recentChatIds = await redis.lrange("recent_chats", 0, -1);
      const recentChats = [];

      for (let chatId of recentChatIds) {
        const chat = await Chat.findOne({ chatId });
        if (chat) recentChats.push({ chatId: chat.chatId, name: chat.name });
      }

      io.emit("recent_chats", recentChats);
    } catch (error) {
      console.error("Ошибка при создании чата:", error);
      socket.emit("error", "Ошибка при создании чата.");
    }
  });

  socket.on("read_redis", async () => 
  {
    try {
      const keys = await redis.keys("*");
      console.log("\nСодержимое Redis:");
  
      if (keys.length === 0) {
        console.log("Redis пуст.");
      } else {
        for (const key of keys) {
          const type = await redis.type(key);
          let value;
  
          switch (type) {
            case "string":
              value = await redis.get(key);
              break;
            case "list":
              value = await redis.lrange(key, 0, -1);
              break;
            case "hash":
              value = await redis.hgetall(key);
              break;
            case "set":
              value = await redis.smembers(key);
              break;
            case "zset":
              value = await redis.zrange(key, 0, -1, "WITHSCORES");
              break;
            default:
              value = "Неизвестный тип данных";
          }
  
          console.log(`Ключ: ${key}, Тип: ${type}, Значение:`, value);
        }
      }
    } catch (err) {
      console.error("Ошибка при чтении данных из Redis:", err);
    }
  })

  socket.on("delete_chat", async (chatId) => {
    try {
      // Удаляем чат и все его сообщения из Redis
      await redis.del(`chat:${chatId}`);
      console.log(`Чат ${chatId} и его сообщения удалены из Redis`);
  
      // Удаляем сам чат из MongoDB
      const deletedChat = await Chat.findOneAndDelete({ chatId });
      if (!deletedChat) {
        console.log(`Чат с ID ${chatId} не найден в MongoDB`);
        socket.emit("error", "Чат не найден.");
        return;
      }
      console.log(`Чат с ID ${chatId} удалён из MongoDB`);
  
      // Удаляем чат из списка последних чатов в Redis (если он там есть)
      await redis.lrem("recent_chats", 0, chatId);
      console.log(`Чат с ID ${chatId} удалён из списка последних чатов в Redis`);
  
      // Отправляем обновлённый список всех чатов
      const allChats = await Chat.find();
      const allChatsList = allChats.map((chat) => ({
        chatId: chat.chatId,
        name: chat.name,
      }));
  
      // Отправляем список чатов всем пользователям
      io.emit("all_chats", allChatsList);
  
      // Отправляем обновлённый список последних чатов
      const recentChatIds = await redis.lrange("recent_chats", 0, -1);
      const recentChats = [];
      for (let chatId of recentChatIds) {
        const chat = await Chat.findOne({ chatId });
        if (chat) recentChats.push({ chatId: chat.chatId, name: chat.name });
      }
      io.emit("recent_chats", recentChats);
  
      // Сообщаем всем, что чат был удалён
      io.emit("chat_deleted", { chatId });
  
      console.log(`Чат с ID ${chatId} успешно удалён`);
    } catch (error) {
      console.error("Ошибка при удалении чата:", error);
      socket.emit("error", "Ошибка при удалении чата.");
    }
  });
  
  

  socket.on("join_chat", async ({ chatId }) => {
    // Проверяем, существует ли ключ в Redis для данного чата
    const existsInRedis = await redis.exists(`chat:${chatId}`);
  
    if (existsInRedis) {
      console.log(`Данные чата ${chatId} найдены в Redis`);
      const messages = await redis.lrange(`chat:${chatId}`, 0, -1);
      const parsedMessages = messages.map((msg) => JSON.parse(msg));
      socket.emit("chat_history", parsedMessages);
    } else {
      console.log(`Данных чата ${chatId} нет в Redis. Берём из MongoDB`);
      const chat = await Chat.findOne({ chatId });
  
      if (chat) {
        const messages2 = chat.messages.map((msg) => JSON.stringify(msg));
        socket.emit("chat_history", messages2);
        console.log(`Сообщения, которые передаются: ${JSON.stringify(messages2, null, 2)}`);

      } else {
        console.log(`Чат с ID ${chatId} не найден ни в Redis, ни в MongoDB`);
        socket.emit("chat_history", []); // Отправляем пустую историю
      }
    }
  
    socket.join(chatId);
    console.log(`Пользователь подключился к чату ${chatId}`);
  });
  
  

  socket.on("leave_chat", ({ chatId }) => {
    socket.leave(chatId);
    console.log(`Пользователь покинул чат ${chatId}`);
  });

  socket.on("send_message", async ({ chatId, sender, message }) => {
    const timestamp = new Date();
    const messageObj = { sender, message, timestamp };
  
    // Проверяем, есть ли история чата в Redis
    const existsInRedis = await redis.exists(`chat:${chatId}`);
    if (!existsInRedis) {
      console.log(`История чата ${chatId} отсутствует в Redis. Загружаем из MongoDB...`);
      const chat = await Chat.findOne({ chatId });
      if (chat && chat.messages) {
        const messagesFromMongo = chat.messages.map((msg) => JSON.stringify(msg));
        await redis.rpush(`chat:${chatId}`, ...messagesFromMongo); // Загружаем историю в Redis
      }
    }
  
    // Добавляем новое сообщение в Redis
    await redis.rpush(`chat:${chatId}`, JSON.stringify(messageObj));
    await redis.ltrim(`chat:${chatId}`, 0, 99); // Храним только последние 100 сообщений
  
    // Добавляем новое сообщение в MongoDB
    await Chat.updateOne(
      { chatId },
      { $push: { messages: messageObj } }
    );
  
    // Обновляем список последних чатов в Redis
    await redis.lrem("recent_chats", 0, chatId); // Удаляем, если уже есть в списке
    await redis.lpush("recent_chats", chatId); // Добавляем в начало
    await redis.ltrim("recent_chats", 0, 4); // Ограничиваем список до 5 элементов
  
    // Отправляем новое сообщение всем пользователям в чате
    io.to(chatId).emit("new_message", { sender, message, timestamp });
  
    // Получаем обновленные сообщения из Redis и отправляем историю в чат
    const updatedMessages = await redis.lrange(`chat:${chatId}`, 0, -1);
    const parsedMessages = updatedMessages.map((msg) => JSON.parse(msg));
    io.to(chatId).emit("chat_history", parsedMessages);
  
    // Обновляем список последних чатов для всех пользователей
    const recentChatIds = await redis.lrange("recent_chats", 0, -1);
    const recentChats = [];
  
    for (let chatId of recentChatIds) {
      const chat = await Chat.findOne({ chatId });
      if (chat) recentChats.push({ chatId: chat.chatId, name: chat.name });
    }
  
    io.emit("recent_chats", recentChats);
  });
  
  

  socket.on("get_recent_chats", async () => {
    const recentChatIds = await redis.lrange("recent_chats", 0, -1); // айдишники недавних чатов 
    const recentChats = [];

    for (let chatId of recentChatIds) {
      const chat = await Chat.findOne({ chatId });
      recentChats.push({ chatId: chat.chatId, name: chat.name });
    }

    socket.emit("recent_chats", recentChats);
  });

  socket.on("get_all_chats", async () => {
    const allChats = await Chat.find();
    socket.emit("all_chats", allChats.map((chat) => ({ chatId: chat.chatId, name: chat.name })));
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
