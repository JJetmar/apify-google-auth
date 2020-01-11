const { OAuth2Client } = require('google-auth-library');
const Apify = require('apify');
const http = require('http');

const { KEYS_STORE, KEYS_RECORD, DEFAULT_TOKENS_STORE, STATIC_PROXY_GROUP } = require('./constants');
const { authorize, close } = require('./submit-page.js');
const { pleaseOpen, liveView, localhost } = require('./asci-text.js');

module.exports.apifyGoogleAuth = async ({ scope, tokensStore, googleCredentials, puppeteerProxy }) => {
    if (!scope) throw new Error('Missing scope parameter! We don\'t know which service you want to use.');

    if (!googleCredentials) {
        googleCredentials = {
            email: process.env.EMAIL,
            password: process.env.PASSWORD,
            secondEmail: process.env.SECOND_EMAIL,
        };
    }

    if ((!googleCredentials.email && googleCredentials.password) || (googleCredentials.email && !googleCredentials.password)) {
        throw new Error('You provided google email but not password or password but not email.');
    }

    const keys = await Apify.client.keyValueStores.getRecord({
        storeId: KEYS_STORE,
        key: KEYS_RECORD,
    }).then((res) => res ? res.body : null);

    if (!keys || !keys.installed || !keys.installed.client_id || !keys.installed.client_secret || !Array.isArray(keys.installed.redirect_uris) || !keys.installed.redirect_uris[0]) {
        throw new Error('Installed keys from developer console are missing or not in the right format, please contact Apify support!');
    }

    const oAuth2Client = new OAuth2Client(
        keys.installed.client_id,
        keys.installed.client_secret,
        keys.installed.redirect_uris[0],
    );

    const tokensRecordKey = `${keys.installed.client_id.match(/(.+)\.apps\.googleusercontent/)[1]}-${scope}`;

    const store = await Apify.openKeyValueStore(tokensStore || DEFAULT_TOKENS_STORE);
    const tokens = await store.getValue(tokensRecordKey);

    if (tokens) {
        console.log('We found tokens saved in our store. No need to authenticate again.');
        const expiryDate = tokens.expiry_date;
        console.log(`access token expires in ${(expiryDate - Date.now()) / 1000} seconds`);
        oAuth2Client.setCredentials(tokens);
        console.info('using stored tokens');
        return oAuth2Client;
    }

    console.log('We have to authenticate to get the tokens');


    const authorizeUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: `https://www.googleapis.com/auth/${scope}`,
    });
    let code;
    if (googleCredentials.email) {
        console.log('You provided an email so we will try to log in with puppeteer. You may have to allow for access after authorization in your email depending on the security level you have.');
        let puppeteerOptions;
        switch (puppeteerProxy) {
            case 'local': console.log('Not using proxy, you should use this option only locally'); puppeteerOptions = { useChrome: true }; break;
            case puppeteerProxy: console.log('Using provided proxy.'); puppeteerOptions = { proxyUrl: puppeteerProxy, useChrome: true }; break;
            default: console.log('Using default static proxy.'); puppeteerOptions = { useApifyProxy: true, apifyProxyGroups: [STATIC_PROXY_GROUP], useChrome: true };
        }

        const browser = await Apify.launchPuppeteer(puppeteerOptions);
        const page = await browser.newPage();
        await page.goto(authorizeUrl);
        await page.waitForSelector('#identifierId');

        try {
            await page.waitFor(2000);
            await page.type('#identifierId', googleCredentials.email);
            await page.waitFor(2000);
            await page.click('#identifierNext');
            await page.waitFor(2000);
            await page.waitForSelector('[type="password"]');
            await page.evaluate((pass) => { document.querySelector('[type="password"]').value = pass; }, googleCredentials.password).catch((e) => console.log('evaluating failed', e));
            await page.waitFor(2000);
            // await saveScreen(page,'after-pass')
            await page.click('#passwordNext');
            await page.waitFor(2000);
            // await saveScreen(page,'after-next')
            try {
                await page.waitForSelector('#knowledge-preregistered-email-response', { timeout: 3000 });
                if (!googleCredentials.secondEmail) {
                    throw new Error('Google wants us to provide second email but there is no in the googleCredentials parameter. Please update it.');
                }
                await page.evaluate((mail) => { document.querySelector('#knowledge-preregistered-email-response').value = mail; }, googleCredentials.secondEmail).catch((e) => console.log('evaluating failed', e));
                await page.waitFor(2000);
                await page.click('#next');
            } catch (e) {
                console.log('e');
            }

            await page.waitForSelector('#submit_approve_access');
            await page.click('#submit_approve_access');
            await page.waitForSelector('#code', { timeout: 120000 });
            code = await page.$eval('#code', (el) => el.value);
            await page.close();
            await browser.close();
        } catch (e) {
            await browser.close();
            console.log(e);
            return null;
        }
    } else {
        const port = Apify.isAtHome() ? process.env.APIFY_CONTAINER_PORT : 3000;
        // const inputUrl = Apify.isAtHome() ? process.env.APIFY_CONTAINER_URL : `localhost:${3000}`
        const information = Apify.isAtHome() ? liveView : localhost;

        console.log(pleaseOpen);
        console.log(information);

        const server = http.createServer((req, res) => {
            if (req.url.includes('/authorize')) {
                let data = '';
                req.on('data', (body) => {
                    if (body) data += body;
                });
                req.on('end', () => {
                    code = decodeURIComponent(data.replace('code=', ''));
                    res.end(close());
                });
            } else {
                res.end(authorize(authorizeUrl));
            }
        });

        server.listen(port, () => console.log('server is listening on port', port));

        const start = Date.now();
        while (!code) {
            const now = Date.now();
            if (now - start > 5 * 60 * 1000) {
                throw new Error('You did not provide the code in time!');
            }
            console.log(`waiting for code...You have ${300 - Math.floor((now - start) / 1000)} seconds left`);
            await new Promise((resolve) => setTimeout(resolve, 10000));
        }

        server.close(() => console.log('closing server'));
    }

    // Now that we have the code, use that to acquire tokens.
    const tokensResponse = await oAuth2Client.getToken(code);
    console.log(`Storing the tokens to your store under key ${tokensRecordKey}`);
    await store.setValue(tokensRecordKey, tokensResponse.tokens);
    oAuth2Client.setCredentials(tokensResponse.tokens);
    console.info('returning authenticated client');
    return oAuth2Client;
};
