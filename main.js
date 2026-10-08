const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load environment variables immediately

console.log('\n╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮');
console.log('│  🚀 Eksu-MD Setup Script   │');
console.log('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n');

// Check if a module exists
function moduleExists(moduleName) {
    try {
        require.resolve(moduleName);
        return true;
    } catch (e) {
        return false;
    }
}

// Check if Yarn is installed
function isYarnInstalled() {
    try {
        execSync('yarn --version', { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

// Install Yarn if not present
function installYarn() {
    console.log('📦 Installing Yarn...');
    try {
        try {
            execSync('npm install -g yarn', { stdio: 'pipe' });
            console.log('✅ Yarn installed globally!\n');
            return true;
        } catch (globalError) {
            console.log('⚠️  Global install failed, installing locally...');
            execSync('npm install yarn', { stdio: 'inherit' });
            console.log('✅ Yarn installed locally!\n');
            return true;
        }
    } catch (error) {
        console.error('❌ Failed to install Yarn:', error.message);
        return false;
    }
}

// Install dependencies with Yarn
function installWithYarn() {
    console.log('📦 Installing dependencies with Yarn...');
    console.log('⏳ This may take 2-5 minutes, please wait...\n');
    
    try {
        console.log('🧹 Cleaning old installations...');
        if (fs.existsSync('node_modules')) execSync('rm -rf node_modules', { stdio: 'pipe' });
        if (fs.existsSync('package-lock.json')) fs.unlinkSync('package-lock.json');
        if (fs.existsSync('yarn.lock')) fs.unlinkSync('yarn.lock');
        console.log('');
        
        let yarnCommand = 'yarn';
        try {
            execSync('yarn --version', { stdio: 'ignore' });
        } catch (e) {
            yarnCommand = 'npx yarn';
        }
        
        console.log(`📥 Running: ${yarnCommand} install --force\n`);
        execSync(`${yarnCommand} install --force --network-timeout 100000`, { 
            stdio: 'inherit',
            timeout: 300000 
        });
        
        console.log('\n✅ Dependencies installed successfully!\n');
        return true;
        
    } catch (error) {
        console.error('❌ Yarn installation failed:', error.message);
        console.log('\n⚠️  Trying with npm instead...\n');
        
        try {
            if (fs.existsSync('node_modules')) execSync('rm -rf node_modules', { stdio: 'pipe' });
            execSync('npm install --legacy-peer-deps --force', { stdio: 'inherit' });
            console.log('\n✅ Installed with npm (fallback)\n');
            return true;
        } catch (npmError) {
            console.error('❌ npm installation also failed:', npmError.message);
            return false;
        }
    }
}

// Create necessary directories
function createDirectories() {
    // Added 'session' to this list to be safe
    const dirs = ['auth_info', 'session', 'temp', 'plugins', 'core'];
    console.log('📁 Creating directories...');
    
    dirs.forEach(dir => {
        const dirPath = path.join(__dirname, dir);
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            console.log(`   ✅ Created: ${dir}/`);
        } else {
            console.log(`   ✓ Exists: ${dir}/`);
        }
    });
    console.log('');
}

// Setup .env file
function setupEnv() {
    const envPath = path.join(__dirname, '.env');
    const envExamplePath = path.join(__dirname, '.env.example');
    
    if (!fs.existsSync(envPath)) {
        if (fs.existsSync(envExamplePath)) {
            console.log('📝 Creating .env file...');
            fs.copyFileSync(envExamplePath, envPath);
            console.log('✅ .env created from template\n');
        } else {
            console.log('📝 Creating default .env file...');
            const defaultEnv = `PREFIX=.
BOT_NAME=Eksu-MD
MODE=public
OWNER_NUMBERS=
SESSION_ID=
AUTO_READ=false
AUTO_TYPING=false
`;
            fs.writeFileSync(envPath, defaultEnv);
            console.log('✅ Default .env created\n');
        }
    } else {
        console.log('✓ .env file exists\n');
    }
}

// Check Node.js version
function checkNodeVersion() {
    const version = process.version;
    const majorVersion = parseInt(version.split('.')[0].replace('v', ''));
    
    console.log(`📌 Node.js: ${version}`);
    if (majorVersion >= 18) {
        console.log('✅ Node version compatible\n');
    } else {
        console.log('⚠️  Warning: Node 18+ recommended\n');
    }
}

// Verify Baileys installation
function verifyBaileys() {
    console.log('🔍 Verifying Baileys installation...');
    if (moduleExists('@whiskeysockets/baileys')) {
        console.log('✅ Baileys installed correctly!\n');
        return true;
    } else {
        console.log('❌ Baileys not found!\n');
        return false;
    }
}

// Main setup function
async function main() {
    try {
        console.log('🔍 Checking system...\n');
        checkNodeVersion();

        if (moduleExists('@whiskeysockets/baileys')) {
            console.log('✅ Dependencies already installed\n');
        } else {
            console.log('❌ Baileys not found, installing dependencies...\n');
            let yarnAvailable = isYarnInstalled();
            if (!yarnAvailable) {
                console.log('❌ Yarn not found, trying install...\n');
                installYarn();
            }
            if (!installWithYarn()) {
                console.log('\n❌ Dependency installation failed! Try manual npm install.');
                process.exit(1);
            }
            if (!verifyBaileys()) {
                console.log('❌ Baileys verification failed.');
                process.exit(1);
            }
        }

        createDirectories();
        setupEnv();

        // Reload env to ensure we see any changes or existing variables
        require('dotenv').config();

        // =================================================================
        // 🔄 SESSION RESTORATION LOGIC (ADDED FIX)
        // =================================================================
        if (process.env.SESSION_ID) {
            console.log('\n🔄 Checks: SESSION_ID detected in environment.');
            const sessionPath = path.join(__dirname, 'session');
            const credsPath = path.join(sessionPath, 'creds.json');

            if (!fs.existsSync(credsPath)) {
                console.log(`📥 Restoring session...`);
                try {
                    const { decodeSession } = require('./core/sessionManager');
                    await decodeSession(process.env.SESSION_ID, sessionPath);
                    console.log('✅ Session restored successfully from .env!');
                } catch (err) {
                    console.error('❌ Failed to restore session. ID might be invalid:', err.message);
                }
            } else {
                console.log('✓ Session files already exist. Skipping restore.');
            }
        }
        // =================================================================

        console.log('╭━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╮');
        console.log('│  ✅ Setup completed successfully!  │');
        console.log('╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯\n');
        
        console.log('📋 Next: Edit .env with your settings if needed\n');
        console.log('🚀 Starting bot in 3 seconds...\n');
        console.log('═'.repeat(50) + '\n');

        setTimeout(() => {
            console.log('🤖 Starting Eksu-MD Bot...\n');
            require('./index.js');
        }, 3000);

    } catch (error) {
        console.error('\n❌ Setup error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main();
