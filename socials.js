// socials.js - Interactive TUI Version (v8.1 - Final Link & Display Fixes)

import blessed from 'blessed';
import axios from 'axios';
import { load } from 'cheerio';
import RssParser from 'rss-parser';
import { subDays, isAfter, formatDistanceToNow } from 'date-fns';
import { writeFile, readFile, readdir, copyFile } from 'fs/promises';
import path from 'path';

const DEFAULT_SETTINGS_FILE = 'settings.json';

// --- Blessed UI Setup ---
const screen = blessed.screen({ smartCSR: true, title: 'Socials Keyword Monitor' });

const output = blessed.box({
    top: 1, left: 0, width: '100%', height: '100%-3',
    border: 'line', label: ' Live Results ', scrollable: true,
    alwaysScroll: true, scrollbar: { ch: ' ', inverse: true },
    keys: true, vi: true, mouse: true, tags: true,
});

output.log = function(text) {
    this.pushLine(text);
    this.setScrollPerc(100);
    screen.render();
};

const input = blessed.textbox({ bottom: 0, left: 0, height: 3, width: '100%', border: 'line', label: ' Command (type "help" for a list) ', inputOnFocus: true, keys: true });
const statusBar = blessed.box({ top: 0, left: 0, height: 1, width: '100%', style: { bg: 'blue' }, tags: true, content: 'Starting...' });

screen.append(statusBar);
screen.append(output);
screen.append(input);

// --- Application State Management ---
const state = {
    keywords: { reddit: new Set(), hn: new Set(), ddg: new Set() },
    limits: {}, globalResultLimit: 10, commandHistory: [],
    historyIndex: 0, isFetching: false, fetchIntervalId: null,
    fetchIntervalMinutes: 5,
};
const parser = new RssParser();
const thirtyDaysAgo = subDays(new Date(), 30);

// --- File Persistence Logic ---
async function saveState(filename) {
    try {
        const savableState = {
            keywords: {
                reddit: [...state.keywords.reddit],
                hn: [...state.keywords.hn],
                ddg: [...state.keywords.ddg],
            },
            limits: state.limits,
            globalResultLimit: state.globalResultLimit,
            fetchIntervalMinutes: state.fetchIntervalMinutes,
        };
        await writeFile(filename, JSON.stringify(savableState, null, 2));
        return true;
    } catch (error) {
        output.log(`{red-fg}Error saving state to ${filename}: ${error.message}{/red-fg}`);
        return false;
    }
}

async function autosaveState() {
    await saveState(DEFAULT_SETTINGS_FILE);
}

function applyState(loadedData) {
    if (!loadedData.keywords || !loadedData.limits || typeof loadedData.fetchIntervalMinutes === 'undefined') {
        throw new Error("Invalid or corrupt settings file.");
    }
    state.keywords.reddit = new Set(loadedData.keywords.reddit || []);
    state.keywords.hn = new Set(loadedData.keywords.hn || []);
    state.keywords.ddg = new Set(loadedData.keywords.ddg || []);
    state.limits = loadedData.limits;
    state.globalResultLimit = loadedData.globalResultLimit || 10;
    state.fetchIntervalMinutes = loadedData.fetchIntervalMinutes;
    restartFetchInterval();
    updateStatusBar();
}

async function loadState(filename) {
    try {
        const fileContent = await readFile(filename, 'utf-8');
        const loadedData = JSON.parse(fileContent);
        applyState(loadedData);
        output.log(`{green-fg}Successfully loaded settings from ${filename}{/green-fg}`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            output.log(`{yellow-fg}No default settings file found. Starting with a blank configuration.{/yellow-fg}`);
        } else {
            output.log(`{red-fg}Error loading state from ${filename}: ${error.message}{/red-fg}`);
        }
    }
}

// --- Data Fetching & Core Logic ---
async function fetchRss(source, url) {
    try {
        const feed = await parser.parseURL(url);
        return feed.items.map(item => ({
            source,
            title: item.title,
            link: item.link,
            date: item.isoDate ? new Date(item.isoDate) : null,
            snippet: (item.contentSnippet || load(item.content || '').text()).trim(),
            rawContent: item.content || ''
        })).filter(item => item.date && isAfter(item.date, thirtyDaysAgo));
    } catch (error) {
        output.log(`{red-fg}Error fetching ${source}: ${error.message}{/red-fg}`);
        return [];
    }
}

async function scrapeDuckDuckGo(keyword) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}`;
    try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = load(data);
        const results = [];
        $('.result').each((i, element) => {
            const title = $(element).find('.result__title a').text().trim();
            let link = $(element).find('.result__title a').attr('href');
            const snippet = $(element).find('.result__snippet').text().trim();

            if (link) {
                // --- FIX: Robustly clean the DDG redirect URL to make it clickable ---
                try {
                    const params = new URLSearchParams(link.split('?')[1]);
                    if (params.has('udgg')) {
                        let cleanedLink = decodeURIComponent(params.get('udgg'));
                        // Ensure it has a protocol for terminal clickability
                        if (!cleanedLink.startsWith('http')) {
                            cleanedLink = 'https://' + cleanedLink;
                        }
                        link = cleanedLink;
                    }
                } catch (e) {
                    // This error can happen if a link doesn't have a '?' (not a redirect)
                    // Still ensure it has a protocol.
                    if (!link.startsWith('http')) {
                         link = 'https://' + link;
                    }
                }
            }

            if (title && link) {
                results.push({ source: 'DuckDuckGo', title, link, date: null, snippet, rawContent: '' });
            }
        });
        return results;
    } catch (error) {
        output.log(`{red-fg}Error scraping DuckDuckGo for "${keyword}": ${error.message}{/red-fg}`);
        return [];
    }
}

function findAndHighlightKeywords(text, keywords) {
    const foundKws = new Set();
    let highlightedText = text;
    for (const kw of keywords) {
        const regex = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        if (regex.test(text)) {
            foundKws.add(kw);
            highlightedText = highlightedText.replace(regex, '{bold}$&{/bold}');
        }
    }
    return { matchedKeywords: [...foundKws], highlightedText };
}

function renderResults(results) {
    if (results.length > 0) {
        output.log(`Displaying ${results.length} results.`);
    }
    for (const result of results) {
        const { item, matchedKeywords, highlightedSnippet } = result;
        const timeAgo = item.date ? formatDistanceToNow(item.date, { addSuffix: true }) : 'N/A';
        const matchedKeywordsString = matchedKeywords.map(kw => `{bold}"${kw}"{/bold}`).join(' ');

        switch (item.source) {
            case 'Reddit':
                const subredditMatch = item.rawContent.match(/r\/(\w+)/);
                const subreddit = subredditMatch ? `/r/${subredditMatch[1]}` : '';
                output.log(`{green-fg}{bold}[Reddit]{/bold} ${subreddit} :: ${matchedKeywordsString}`);
                output.log(`  ${item.title}`);
                output.log(`  {gray-fg}${item.link}{/gray-fg} - ${timeAgo}`);
                break;
            case 'Hacker News':
            case 'DuckDuckGo':
                output.log(`{green-fg}{bold}[${item.source}]{/bold}`);
                output.log(`  ${item.title}`);
                if (matchedKeywords.length > 0) {
                    output.log(`  Keywords: ${matchedKeywordsString}`);
                }
                output.log(`  ${highlightedSnippet}`);
                output.log(`  {gray-fg}https:${item.link}{/gray-fg}`);
                break;
        }
        output.log('');
    }
}

async function fetchAllData(header = "Update Complete") {
    if (state.isFetching) return;
    state.isFetching = true;
    updateStatusBar();
    output.log(`{yellow-fg}Checking for new items...{/yellow-fg}`);

    const allFetchTasks = [];
    state.keywords.reddit.forEach(kw => allFetchTasks.push(fetchRss('Reddit', `https://www.reddit.com/search.rss?q=${encodeURIComponent(kw)}&sort=new`)));
    state.keywords.hn.forEach(kw => allFetchTasks.push(fetchRss('Hacker News', `http://hn.algolia.com/rss?query=${encodeURIComponent(kw)}`)));
    state.keywords.ddg.forEach(kw => allFetchTasks.push(scrapeDuckDuckGo(kw)));

    if (allFetchTasks.length === 0) {
        output.log('No keywords to monitor. Add some with `+ "my keyword"`');
        state.isFetching = false;
        updateStatusBar();
        return;
    }

    const allResultsRaw = (await Promise.all(allFetchTasks)).flat();
    
    const uniqueResults = new Map();
    allResultsRaw.forEach(item => { if (item.link && !uniqueResults.has(item.link)) { uniqueResults.set(item.link, item); } });

    const sourceKeyMap = { 'Reddit': 'reddit', 'Hacker News': 'hn', 'DuckDuckGo': 'ddg' };
    const allKeywords = new Set([...state.keywords.reddit, ...state.keywords.hn, ...state.keywords.ddg]);
    let finalResults = [];

    for (const item of uniqueResults.values()) {
        const { matchedKeywords, highlightedText } = findAndHighlightKeywords(item.title + ' ' + item.snippet, allKeywords);
        if (matchedKeywords.length > 0) {
            finalResults.push({
                item,
                matchedKeywords,
                highlightedSnippet: highlightedText.substring(item.title.length + 1)
            });
        }
    }

    const limitedResults = {};
    for (const source of Object.keys(sourceKeyMap)) { limitedResults[source] = []; }
    for (const res of finalResults) { if (limitedResults[res.item.source]) { limitedResults[res.item.source].push(res); } }

    const displayResults = [];
    for (const sourceName of Object.keys(limitedResults)) {
        const sourceStateKey = sourceKeyMap[sourceName];
        const limit = state.limits[sourceStateKey] ?? state.globalResultLimit;
        displayResults.push(...limitedResults[sourceName].slice(0, limit));
    }

    displayResults.sort((a, b) => (b.item.date || 0) - (a.item.date || 0));

    if (header) { output.log(`{bold}--- ${header} ---{/bold}`); }
    renderResults(displayResults);
    state.isFetching = false;
    updateStatusBar();
}

function displayHelp() {
    output.log('{bold}{underline}Available Commands{/underline}{/bold}');
    output.log('{cyan-fg}+/- "kw" or +/-<src> "kw"{/cyan-fg} - Add/remove keywords for sources.');
    output.log('{cyan-fg}~<src> <limit|default>{/cyan-fg} - Set per-source limit or reset to global.');
    output.log('{cyan-fg}list{/cyan-fg}                      - Show a summary of all monitored keywords.');
    output.log('{cyan-fg}set list <number>{/cyan-fg}        - Set the global default for max results per source.');
    output.log('{cyan-fg}set interval <min>{/cyan-fg}     - Set fetch interval in minutes.');
    output.log('{cyan-fg}save / load / set default{/cyan-fg} - Manage settings files.');
    output.log('{cyan-fg}fetch / clear / help / exit{/cyan-fg}  - Utility commands.');
    output.log('');
}

function listSettings() {
    output.log('{bold}--- Current Keyword Settings ---{/bold}');
    for (const source of ['reddit', 'hn', 'ddg']) {
        const keywords = state.keywords[source];
        if (keywords.size > 0) {
            output.log(`{green-fg}{bold}[${source.toUpperCase()}]{/bold}`);
            keywords.forEach(kw => output.log(`  - "${kw}"`));
        }
    }
    output.log('');
}

async function handleCommand(command) {
    if (!command) return;
    const parts = command.match(/"([^"]+)"|'([^']+)'|(\S+)/g) || [];
    const action = parts.shift().toLowerCase();
    const args = parts.map(p => p.replace(/["']/g, ''));
    const sources = ['reddit', 'hn', 'ddg'];
    let stateChanged = false;

    if (action.startsWith('+') || action.startsWith('-')) {
        const sourceMatch = action.substring(1);
        let targetSources = sources.includes(sourceMatch) ? [sourceMatch] : sources;
        args.forEach(kw => targetSources.forEach(s => action.startsWith('+') ? state.keywords[s].add(kw) : state.keywords[s].delete(kw)));
        output.log(`{green-fg}Keywords updated.{/green-fg}`);
        stateChanged = true;
        fetchAllData(`Fetching for new keywords...`);
    } else if (action.startsWith('~')) {
        const source = action.substring(1);
        if (!sources.includes(source)) { output.log(`{red-fg}Invalid source: ${source}{/red-fg}`); return; }
        if (!args[0]) {
            listSettings();
        } else if (args[0].toLowerCase() === 'default') {
            delete state.limits[source];
            output.log(`{green-fg}${source} limit reset to global default (${state.globalResultLimit}).{/green-fg}`);
            stateChanged = true;
        } else {
            const limit = parseInt(args[0], 10);
            if (!isNaN(limit) && limit >= 0) {
                state.limits[source] = limit;
                output.log(`{green-fg}Set ${source} specific result limit to ${limit}.{/green-fg}`);
                stateChanged = true;
            } else {
                output.log(`{red-fg}Invalid limit. Use a number or "default". Ex: ~hn 5{/red-fg}`);
            }
        }
    } else if (action === 'list') {
        listSettings();
    } else if (action === 'set') {
        const setting = args[0] ? args[0].toLowerCase() : '';
        if (setting === 'list') {
            const value = parseInt(args[1], 10);
            if (!isNaN(value) && value >= 0) {
                state.globalResultLimit = value;
                output.log(`{green-fg}Global result limit set to ${value}.{/green-fg}`);
                stateChanged = true;
            } else { output.log(`{red-fg}Usage: set list <number>{/red-fg}`); }
        } else if (setting === 'interval') {
            const value = parseInt(args[1], 10);
            if (!isNaN(value) && value > 0) {
                state.fetchIntervalMinutes = value;
                restartFetchInterval();
                output.log(`{green-fg}Fetch interval updated to ${value} minutes.{/green-fg}`);
                stateChanged = true;
            } else { output.log(`{red-fg}Usage: set interval <minutes>{/red-fg}`); }
        } else if (setting === 'default') {
            if (!args[1]) {
                output.log(`{red-fg}Usage: set default <filename.json>{/red-fg}`);
            } else {
                try {
                    await copyFile(args[1], DEFAULT_SETTINGS_FILE);
                    output.log(`{green-fg}Successfully set ${args[1]} as the new default.{/green-fg}`);
                } catch (error) { output.log(`{red-fg}Error setting default: ${error.message}{/red-fg}`); }
            }
        } else { output.log(`{red-fg}Invalid set command. See 'help'.{/red-fg}`); }
    } else if (action === 'save') {
        if (!args[0]) { output.log(`{red-fg}Usage: save <filename.json>{/red-fg}`); }
        else if (await saveState(args[0])) { output.log(`{green-fg}Settings saved to ${args[0]}{/green-fg}`); }
    } else if (action === 'load') {
        if (!args[0]) { output.log(`{red-fg}Usage: load <filename>{/red-fg}`); }
        else {
            try {
                const files = await readdir('.');
                const targetFile = files.find(f => f.startsWith(args[0]) && f.endsWith('.json'));
                if (targetFile) { await loadState(targetFile); }
                else { output.log(`{red-fg}No settings file found starting with "${args[0]}"{/red-fg}`); }
            } catch (error) { output.log(`{red-fg}Error reading directory: ${error.message}{/red-fg}`); }
        }
    } else if (command === 'help') {
        displayHelp();
    } else if (command === 'fetch') {
        fetchAllData();
    } else if (command === 'clear') {
        output.setContent('');
    } else if (command === 'exit') {
        return process.exit(0);
    } else if (!action.startsWith('~')) {
        output.log(`{red-fg}Unknown command: ${command}{/red-fg}`);
    }

    if (stateChanged) await autosaveState();
    updateStatusBar();
}

function restartFetchInterval() {
    if (state.fetchIntervalId) clearInterval(state.fetchIntervalId);
    const newIntervalMs = state.fetchIntervalMinutes * 60 * 1000;
    state.fetchIntervalId = setInterval(fetchAllData, newIntervalMs);
}

function updateStatusBar() {
    const kwString = ['reddit', 'hn', 'ddg'].map(s => `${s}:[${[...state.keywords[s]].join(',')}]`).join(' | ');
    const status = state.isFetching ? '{yellow-fg}Fetching...{/yellow-fg}' : '{green-fg}Idle{/green-fg}';
    statusBar.setContent(` ${status} | Keywords: ${kwString}`);
    screen.render();
}

// --- Event Handlers & Main Loop ---
input.on('submit', (value) => { if (value) { state.commandHistory.push(value); state.historyIndex = state.commandHistory.length; handleCommand(value); } input.clearValue(); input.focus(); screen.render(); });
input.key(['up', 'down'], (ch, key) => { if (key.name === 'up') { state.historyIndex = Math.max(0, state.historyIndex - 1); } else { state.historyIndex = Math.min(state.commandHistory.length, state.historyIndex + 1); } const command = state.commandHistory[state.historyIndex] || ''; input.setValue(command); input.editor.moveCursor(command.length); screen.render(); });
screen.key(['escape', 'C-c'], () => process.exit(0));

async function start() {
    await loadState(DEFAULT_SETTINGS_FILE);
    displayHelp();
    if ([...state.keywords.reddit, ...state.keywords.hn, ...state.keywords.ddg].length > 0) {
        output.log('{yellow-fg}Performing initial fetch based on loaded settings...{/yellow-fg}');
        await fetchAllData("Initial Fetch");
    }
    input.focus();
    screen.render();
}

start();
