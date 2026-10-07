'use strict';

/**
 * 启动入口：只负责读取配置、创建应用并监听端口。
 * 业务逻辑集中在 lib/diary.js，便于测试与复用。
 */

const path = require('path');
const express = require('express');
const { createApp } = require('./lib/diary');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = createApp({
  diaryDir: path.join(__dirname, 'diaries'),
  publicDir: path.join(__dirname, 'public'),
  express,
});

const server = app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Diary site running: http://${shown}:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，可用 PORT=3001 node server.js 指定其他端口。`);
  } else {
    console.error('服务启动失败:', err);
  }
  process.exitCode = 1;
});

// 优雅退出，便于本地开发和进程管理器重启
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
