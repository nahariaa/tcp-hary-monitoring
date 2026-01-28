const puppeteer = require('puppeteer');
const fs = require('fs');
const nodemailer = require('nodemailer');

// --- CONFIGURATION ---
const TARGET_URL = 'https://edraw.tcpharyana.gov.in/tcp-dms/home';
const HISTORY_FILE = 'history.json';

// --- SECRETS ---
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = process.env.EMAIL_TO; // Can be comma-separated

// --- EMAILER ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

async function run() {
    let browser;
    try {
        console.log('🚀 Launching Browser...');
        
        // Launch Chrome with arguments to bypass sandbox issues in CI environments
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Handles memory issues in Docker
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', 
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();

        // 1. MASQUERADE AS A HUMAN (Crucial for gov firewalls)
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1280, height: 800 });

        // 2. NAVIGATE WITH ROBUST TIMEOUTS
        console.log('🌍 Navigating to TCP Portal...');
        
        // We accept 'domcontentloaded' because gov sites often have slow trackers that block 'networkidle'
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 3. WAIT FOR DATA TO APPEAR
        console.log('⏳ Waiting for project list...');
        // Wait for the specific container that holds the projects
        try {
            await page.waitForSelector('.eproc-listing-main', { timeout: 30000 });
        } catch (e) {
            console.log("⚠️ No projects found or page too slow. Taking screenshot for debug...");
            // Only strictly needed for debugging, but good for "set and forget"
            // await page.screenshot({ path: 'debug_fail.png' });
            throw new Error('Project list did not load within 30s.');
        }

        // 4. SCRAPE DATA (Execute logic inside the browser page)
        const projects = await page.evaluate(() => {
            const data = {};
            const cards = document.querySelectorAll('.eproc-listing-main');

            cards.forEach(card => {
                // Extract ID
                const idLabel = card.querySelector('.index label');
                const id = idLabel ? idLabel.innerText.replace(/\D/g, '') : 'unknown';

                // Extract Name (It's often in the .department span)
                const nameEl = card.querySelector('.ref-dept .department span');
                const name = nameEl ? nameEl.innerText.trim() : 'Unknown Project';

                // Extract Links
                const drawLinkEl = card.querySelector('a[title="Details of Draw"]');
                const brochureLinkEl = card.querySelector('a[title="Building Plan & Brochure"]');
                
                // Extract Dates
                const startEl = card.querySelector('.start-date');
                const endEl = card.querySelector('.end-date');

                if (id !== 'unknown') {
                    data[id] = {
                        id,
                        name,
                        startDate: startEl ? startEl.innerText.replace('Online Application Start Date :', '').trim() : 'N/A',
                        endDate: endEl ? endEl.innerText.replace('Online Application End Date & Time :', '').trim() : 'N/A',
                        drawLink: drawLinkEl ? drawLinkEl.href : '#',
                        brochureLink: brochureLinkEl ? brochureLinkEl.href : '#'
                    };
                }
            });
            return data;
        });

        console.log(`✅ Scraped ${Object.keys(projects).length} projects.`);

        // 5. COMPARE HISTORY (Same logic as before)
        processChanges(projects);

    } catch (error) {
        console.error('❌ FATAL ERROR:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

function processChanges(currentProjects) {
    let history = {};
    if (fs.existsSync(HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE));
    }

    const added = [];
    
    // Check for New
    for (const id in currentProjects) {
        if (!history[id]) {
            added.push(currentProjects[id]);
        }
    }

    if (added.length > 0) {
        console.log(`Found ${added.length} new projects. Sending email...`);
        sendEmail(added).then(() => {
            // Only save if email succeeds
            const newHistory = { ...history, ...currentProjects }; // Merge to keep old records too
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(newHistory, null, 2));
        });
    } else {
        console.log('No new projects found.');
    }
}

async function sendEmail(added) {
    let html = `<h2>🚀 New Housing Schemes in Haryana</h2>`;
    
    added.forEach(p => {
        html += `
        <div style="border:1px solid #ccc; padding:15px; margin-bottom:10px; border-radius:8px;">
            <h3 style="margin:0 0 5px 0;">${p.name} (ID: ${p.id})</h3>
            <p><strong>Apply:</strong> ${p.startDate} to ${p.endDate}</p>
            <a href="${p.brochureLink}" style="background:#27ae60; color:#fff; padding:8px 12px; text-decoration:none; border-radius:4px;">Download Brochure</a>
            <a href="${p.drawLink}" style="background:#2980b9; color:#fff; padding:8px 12px; text-decoration:none; border-radius:4px;">Draw Details</a>
        </div>`;
    });

    const recipients = EMAIL_TO.split(','); // Handle multiple emails

    await transporter.sendMail({
        from: `"TCP Monitor" <${EMAIL_USER}>`,
        bcc: recipients, // Use BCC for multiple people
        subject: `New TCP Scheme Alert: ${added[0].name}`,
        html: html
    });
}

run();