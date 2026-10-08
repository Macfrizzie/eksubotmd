const { Module } = require('../core/handler');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { writeFile, unlink } = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execPromise = promisify(exec);

Module({
    pattern: "sticker ?(.*)",
    fromMe: false,
    desc: "Convert image/video to sticker",
    type: "media"
}, async (m) => {
    try {
        const quoted = m.reply_message?.data?.message || m.message;
        const targetMessage = m.reply_message ? m.reply_message.data.message : m.message;

        if (!targetMessage) {
            return await m.reply('❌ Please reply to an image or short video with .sticker');
        }

        const mediaType = Object.keys(targetMessage).find(k => ['imageMessage', 'videoMessage'].includes(k));

        if (!mediaType) {
            return await m.reply('❌ Please reply to an image or video under 10 seconds!');
        }

        await m.reply('⏳ Creating sticker...');

        const stream = await downloadContentFromMessage(
            targetMessage[mediaType], 
            mediaType.replace('Message', '')
        );

        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const tempDir = path.join(__dirname, '../temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        const ext = mediaType === 'videoMessage' ? 'mp4' : 'jpg';
        const inputPath = path.join(tempDir, `input_${Date.now()}.${ext}`);
        const outputPath = path.join(tempDir, `sticker_${Date.now()}.webp`);

        await writeFile(inputPath, buffer);

        // Convert to webp sticker with ffmpeg
        if (mediaType === 'imageMessage') {
            await execPromise(`ffmpeg -i "${inputPath}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" "${outputPath}"`);
        } else {
            await execPromise(`ffmpeg -i "${inputPath}" -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" -t 00:00:06 -c:v libwebp -loop 0 "${outputPath}"`);
        }

        const stickerBuffer = fs.readFileSync(outputPath);

        await m.client.sendMessage(m.jid, {
            sticker: stickerBuffer
        }, { quoted: m });

        // Clean up
        try { await unlink(inputPath); } catch (e) {}
        try { await unlink(outputPath); } catch (e) {}

    } catch (error) {
        console.error('Sticker conversion error:', error.message);
        await m.reply('❌ Failed to create sticker. Ensure ffmpeg is installed and media is valid.');
    }
});