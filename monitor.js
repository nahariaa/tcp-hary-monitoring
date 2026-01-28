const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('qs');
const fs = require('fs');
const nodemailer = require('nodemailer');

// --- CONFIGURATION ---
const BASE_URL = 'https://edraw.tcpharyana.gov.in';
const HOME_URL = `${BASE_URL}/tcp-dms/home`;
const SEARCH_URL = `${BASE_URL}/tcp-dms/ajax/search-scheme`;
const HISTORY_FILE = 'history.json';

// --- SECRETS (From GitHub Actions) ---
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = process.env.EMAIL_TO;

// --- EMAIL TRANSPORTER ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
});

// --- MAIN FUNCTION ---
async function run() {
    try {
        console.log('1. Fetching Homepage to get fresh Tokens...');
        // We use a jar to store cookies automatically if we were using a library like 'request', 
        // but with axios we manually handle the cookie header.
        
        const homeResponse = await axios.get(HOME_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        // Extract Session Cookie
        const cookies = homeResponse.headers['set-cookie'];
        let cookieHeader = '';
        if (cookies) {
            cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');
        }

        // Extract CSRF Token from the HTML (It's usually in a meta tag or hidden input)
        const $home = cheerio.load(homeResponse.data);
        const csrfToken = $home('input[name="_csrf"]').val() || $home('meta[name="_csrf"]').attr('content');

        if (!csrfToken) {
            throw new Error('Could not retrieve CSRF token from homepage.');
        }
        console.log(`   Tokens acquired. CSRF: ${csrfToken.substring(0, 10)}...`);

        // --- PREPARE THE SEARCH REQUEST ---
        // This mimics your curl command exactly
        const postData = qs.stringify({
            'keywrdSearch': '',
            'district': '',
            'town': '',
            'colonizer': '',
            'moduleType': '2',
            'searchType': '1',
            'lstType': '1',
            'totalPages': '',
            'xStatus': '6', // This seems to filter for "Open" schemes
            'perPage': '10',
            'currentPage': '1',
            'clientID': '2',
            'langID': '1',
            'langCode': 'en',
            '_csrf': csrfToken
        });

        console.log('2. Fetching Projects List...');
        const searchResponse = await axios.post(SEARCH_URL, postData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Cookie': cookieHeader,
                'X-CSRF-TOKEN': csrfToken,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Origin': BASE_URL,
                'Referer': HOME_URL,
                'X-Requested-With': 'XMLHttpRequest'
            }
        });

        // --- PARSE PROJECTS ---
        const $ = cheerio.load(searchResponse.data);
        const currentProjects = {};

        $('.eproc-listing-main').each((i, el) => {
            const idText = $(el).find('.index label').text().trim();
            const projectId = idText.replace(/\D/g, ''); // Extract numbers only

            // Name is usually the first span in department div
            const name = $(el).find('.ref-dept .department span').first().text().trim();
            
            // Dates
            const startDate = $(el).find('.start-date').text().replace('Online Application Start Date', '').replace(':', '').trim();
            const endDate = $(el).find('.end-date').text().replace('Online Application End Date & Time', '').replace(':', '').trim();

            // Links
            const drawLink = BASE_URL + $(el).find('a[title="Details of Draw"]').attr('href');
            const brochureLink = BASE_URL + $(el).find('a[title="Building Plan & Brochure"]').attr('href');

            if (projectId) {
                currentProjects[projectId] = {
                    id: projectId,
                    name: name,
                    startDate: startDate,
                    endDate: endDate,
                    drawLink: drawLink,
                    brochureLink: brochureLink,
                    fullHtml: $(el).html() // We save a bit of HTML to reconstruct email
                };
            }
        });

        console.log(`   Found ${Object.keys(currentProjects).length} active projects.`);

        // --- COMPARE WITH HISTORY ---
        let history = {};
        if (fs.existsSync(HISTORY_FILE)) {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE));
        }

        const added = [];
        const removed = [];

        // Check for New
        for (const id in currentProjects) {
            if (!history[id]) {
                added.push(currentProjects[id]);
            }
        }

        // Check for Removed
        for (const id in history) {
            if (!currentProjects[id]) {
                removed.push(history[id]);
            }
        }

        // --- SEND EMAIL IF CHANGES DETECTED ---
        if (added.length > 0 || removed.length > 0) {
            console.log(`Changes detected! Added: ${added.length}, Removed: ${removed.length}. Sending email...`);
            await sendUpdateEmail(added, removed);
            
            // Save new state
            fs.writeFileSync(HISTORY_FILE, JSON.stringify(currentProjects, null, 2));
        } else {
            console.log('No changes detected.');
        }

    } catch (error) {
        console.error('CRITICAL ERROR:', error.message);
        if(error.response) console.error(error.response.status);
        process.exit(1); 
    }
}

// --- EMAIL GENERATOR ---
async function sendUpdateEmail(added, removed) {
    let htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
        <h2 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">TCP Haryana Monitor Update</h2>
    `;

    if (added.length > 0) {
        htmlContent += `<h3 style="color: #27ae60;">🚀 New Projects Added (${added.length})</h3>`;
        added.forEach(p => {
            htmlContent += generateProjectCard(p);
        });
    }

    if (removed.length > 0) {
        htmlContent += `<h3 style="color: #c0392b; margin-top: 30px;">❌ Projects Removed/Closed (${removed.length})</h3>`;
        removed.forEach(p => {
            htmlContent += generateProjectCard(p, true);
        });
    }

    htmlContent += `
        <div style="margin-top: 20px; font-size: 12px; color: #7f8c8d;">
            <p>This is an automated message. <a href="${HOME_URL}">Visit TCP Haryana Portal</a></p>
        </div>
    </div>`;

    await transporter.sendMail({
        from: `"TCP Monitor" <${EMAIL_USER}>`,
        to: EMAIL_TO,
        subject: `📢 TCP Update: ${added.length} Added, ${removed.length} Removed`,
        html: htmlContent
    });
}

function generateProjectCard(p, isRemoved = false) {
    const style = isRemoved ? "opacity: 0.7; filter: grayscale(1);" : "";
    return `
    <div style="border: 1px solid #ddd; padding: 15px; margin-bottom: 15px; border-radius: 5px; background-color: #f9f9f9; ${style}">
        <div style="font-weight: bold; font-size: 16px; color: #333; margin-bottom: 5px;">
            ${p.id}) ${p.name}
        </div>
        <div style="font-size: 13px; color: #555; margin-bottom: 10px;">
            📅 <strong>Start:</strong> ${p.startDate} <br>
            📅 <strong>End:</strong> ${p.endDate}
        </div>
        <div style="margin-top: 10px;">
            <a href="${p.drawLink}" style="background-color: #3498db; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px; font-size: 12px; margin-right: 10px;">Details of Draw</a>
            <a href="${p.brochureLink}" style="background-color: #27ae60; color: white; padding: 5px 10px; text-decoration: none; border-radius: 3px; font-size: 12px;">Brochure</a>
        </div>
    </div>
    `;
}

run();