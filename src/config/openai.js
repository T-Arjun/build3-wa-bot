'use strict';

const OpenAI = require('openai');
const { env } = require('./env');

let client = null;

function openai() {
  if (client) return client;
  if (!env.openai.apiKey) {
    throw new Error('OpenAI not configured: set OPENAI_API_KEY');
  }
  client = new OpenAI({ apiKey: env.openai.apiKey });
  return client;
}

module.exports = { openai };
