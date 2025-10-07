/* script.js — Speak Roots: animations + sound (WebAudio) + streak-claim popup.
   Paste into your JS pane to replace the old script.js
   --- CLEANED: phone/OTP/recaptcha removed. Social sign-in added.
*/

/* ========== STATE ========= */
const state = {
  user: null,
  voiceOn: true,
  streakDays: 0,
  lastStreakDate: null,
  todayDone: false,
  firebase: { app:null, auth:null, db:null, analytics:null, _mods:{} },
};
/* ========== DOM HELPERS & showScreen (hardened + accessible) ========= */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
// Improved logout handler (paste somewhere after `state` is available and after DOM helpers)
const logoutBtn = $('#logoutBtn');
if(logoutBtn){
  // ensure it's a real button (avoids accidental form submit)
  logoutBtn.type = 'button';

  logoutBtn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    try{
      playSfx?.('click');
    }catch(e){ /* ignore */ }

    console.log('[BRX] logout clicked — user:', state.user);
    logoutBtn.disabled = true;

    try{
      // If using Supabase (global `supabase` object)
      if(window.supabase && typeof supabase.auth?.signOut === 'function'){
        console.log('[BRX] signing out via Supabase...');
        const { error } = await supabase.auth.signOut();
        if(error) throw error;
      }
      // Else if Firebase initialized (old fallback)
      else if(state.firebase && state.firebase._mods && state.firebase.auth){
        console.log('[BRX] signing out via Firebase...');
        await state.firebase._mods.authMod.signOut(state.firebase.auth);
      } else {
        console.log('[BRX] no cloud auth detected — doing local sign out.');
      }
    }catch(err){
      console.warn('[BRX] logout failed:', err);
      // show a friendly message but keep going
      try{ alert(err.message || String(err)); }catch(e){}
    } finally {
      // clear local state & UI
      state.user = null;
      showScreen('auth');
      refreshAuthUI();
      logoutBtn.disabled = false;
      console.log('[BRX] logout complete. UI reset.');
    }
  });
}

const screens = [
  "auth","menu","dictionary","englishLearning",
  "childABC","childABCQuiz","childMath",
  "englishQuiz",
  "tables","tableView","practiceView","testView","tableProgress","tableHelp","tableReport",
  "science","scienceClassSelect","scienceQuiz","scienceResults","learnScience",
  "gk","leaderboard",
  "speaking","modernWords","miniGames"
];


function stopSpeaking(){
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch(e){}
}

// set aria-hidden reliably (visible: boolean)
function setAriaHidden(el, visible){
  try{ if(el && typeof el.setAttribute === 'function') el.setAttribute('aria-hidden', visible ? 'false' : 'true'); }catch(e){}
}

// focus first focusable descendant for accessibility
function focusFirstDescendant(root){
  if(!root || !root.querySelector) return;
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const node = root.querySelector(selector);
  try{ if(node && typeof node.focus === 'function') node.focus(); }catch(e){}
}

/**
 * showScreen(id)
 * - toggles .active on screens present in `screens`
 * - sets aria-hidden appropriately
 * - resets scroll and focuses the first interactive element for accessibility
 * - clears dictionary state if opening dictionary
 * - stops ABC autoplay when leaving childABC
 *
 * NOTE: To avoid an initial focus paint (which produced the blank border on first load),
 * we intentionally skip the autofocus on the very first showScreen() call. Subsequent calls
 * will autofocus normally for accessibility.
 */
function showScreen(id){
  if(typeof id !== 'string'){
    console.warn('showScreen called with non-string id:', id);
    return;
  }

  // ensure our one-time autofocus guard exists
  if(typeof window.__brx_hasAutofocusedOnce === 'undefined') window.__brx_hasAutofocusedOnce = false;

  stopSpeaking();

  let found = false;
  screens.forEach(s => {
    const el = document.getElementById(s);
    if(!el) return;
    const active = (s === id);
    // toggle visual state
    try{ el.classList.toggle('active', active); }catch(e){}
    // set aria-hidden for screen readers
    setAriaHidden(el, active);
    if(active){
      found = true;
      // reset scroll for this screen (guarded)
      try{ if('scrollTop' in el) el.scrollTop = 0; }catch(e){}
      // a11y: focus first interactive element inside the screen
      try{
        // Skip autofocus on the very first app show to avoid the initial focus outline glitch.
        if(window.__brx_hasAutofocusedOnce){
          focusFirstDescendant(el);
        } else {
          // mark that we've shown at least once; next calls will autofocus as usual
          window.__brx_hasAutofocusedOnce = true;
          // (do not focus now to avoid the initial border/focus-paint issue)
        }
      }catch(e){}
    }
  });

  // also reset main container scroll (guarded)
  try{
    const appEl = document.querySelector('.app');
    if(appEl && 'scrollTop' in appEl) appEl.scrollTop = 0;
  }catch(e){}

  // scroll page to top (guarded)
  try{ window.scrollTo({ top: 0, behavior: "instant" }); }catch(e){}

  // Clear dictionary input/results whenever dictionary is opened
  if(id === 'dictionary'){
    try{
      const dictInput = document.getElementById('dictInput');
      const dictResult = document.getElementById('dictResult');
      const dictTransResult = document.getElementById('dictTransResult');
      if(dictInput) dictInput.value = "";
      if(dictResult) dictResult.innerHTML = "";
      if(dictTransResult) dictTransResult.textContent = "";
    }catch(e){}
  }

  // Stop ABC autoplay when leaving childABC
  if(id !== 'childABC' && window.ABCapp && typeof window.ABCapp.stopAutoPlay === 'function'){
    try{ window.ABCapp.stopAutoPlay(); }catch(e){}
  }

  if(!found){
    console.warn(`showScreen: screen id "${id}" not found in DOM. Ensure <section id="${id}"> exists inside <body>.`);
  }
}


/* ========== WEB AUDIO SFX (synthesized) ========== */
const audioCtx = (() => {
  try { return new (window.AudioContext || window.webkitAudioContext)(); }
  catch(e){ return null; }
})();

// preserve old playSfx if present (fallback)
const _oldPlaySfx = typeof window.playSfx === 'function' ? window.playSfx : null;

// keep default click exactly as original
window.DEFAULT_CLICK_SFX = window.DEFAULT_CLICK_SFX || 'click';

/**
 * _playTone(freq, dur, type, when, vol)
 */
function _playTone(freq, dur = 0.12, type = 'sine', when = 0, vol = 0.18){
  if(!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.connect(g);
  g.connect(audioCtx.destination);
  const now = audioCtx.currentTime + when;

  // safe envelope: try exponential, fallback to linear
  try{
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  } catch(e){
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(Math.max(0.0001, vol), now + 0.01);
    g.gain.linearRampToValueAtTime(0, now + dur);
  }

  o.start(now);
  o.stop(now + dur + 0.02);
}

/**
 * _playPattern(pattern)
 * pattern: [{f|freq, d|dur, t|type, delay, vol, type:'noise'} , ...]
 */
function _playPattern(pattern){
  if(!audioCtx || !Array.isArray(pattern)) return;
  pattern.forEach(p=>{
    const when = p.delay || 0;
    if(p.type === 'noise' || p.t === 'noise'){
      const length = Math.max(0.02, p.d || p.dur || 0.06);
      const samples = Math.floor(audioCtx.sampleRate * length);
      const buffer = audioCtx.createBuffer(1, samples, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      const mag = p.vol !== undefined ? p.vol : 0.12;
      for(let i=0;i<samples;i++) data[i] = (Math.random()*2 - 1) * mag;
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + when);
      g.gain.linearRampToValueAtTime(mag, audioCtx.currentTime + when + 0.01);
      g.gain.linearRampToValueAtTime(0.0001, audioCtx.currentTime + when + length);
      src.connect(g); g.connect(audioCtx.destination);
      src.start(audioCtx.currentTime + when);
      return;
    }
    _playTone(p.f || p.freq || 700, p.d || p.dur || 0.08, p.t || p.type || 'sine', when, p.vol !== undefined ? p.vol : 0.18);
  });
}

// Presets: adjust frequencies/volumes here if you'd like
const SFX_PRESETS = {
  // keep default click identical to your original
  click:     [{f:900,d:0.06}],
  // other useful presets
  softClick: [{f:1200,d:0.05,vol:0.08}],
  pop:       [{f:900,d:0.06},{f:1200,d:0.04,delay:0.06}],
  correct:   [{f:700,d:0.10},{f:880,d:0.08,delay:0.09}],
  wrong:     [{f:220,d:0.18}],
  cheer:     [{f:660,d:0.10},{f:880,d:0.10,delay:0.09},{f:990,d:0.10,delay:0.18}],
  coin:      [{f:1100,d:0.06},{f:1400,d:0.04,delay:0.06}],
  nav:       [{f:740,d:0.06}],
  levelUp:   [{f:880,d:0.08},{f:1100,d:0.10,delay:0.09}],
  bell:      [{f:880,d:0.12},{f:1320,d:0.08,delay:0.12}],
  // action-specific (used for logout / toggles)
  punch:     [{type:'noise', d:0.06, vol:0.22}],   // assertive (good for logout)
  toggle:    [{f:1000,d:0.05,vol:0.10},{f:1400,d:0.03,delay:0.05}], // switch-like (sound on/off)
  theme:     [{f:840,d:0.06},{f:1100,d:0.06,delay:0.07}] // theme (dark/light)
};

/**
 * playSfx(type)
 * Accepts:
 *  - preset name string (e.g. 'click', 'punch', 'toggle')
 *  - array pattern
 *  - object {pattern: [...]}, or single-tone object {f:..., d:...}
 */
function playSfx(type = "click"){
  try{
    if(!audioCtx) return;
    // ensure AudioContext resumed (autoplay policy)
    if(audioCtx.state === 'suspended'){
      audioCtx.resume().catch(()=>{});
    }

    // legacy: keep literal 'click' as the exact original click
    if(Array.isArray(type)){ _playPattern(type); return; }

    if(typeof type === 'string'){
      const preset = SFX_PRESETS[type];
      if(preset){ _playPattern(preset); return; }
      // else fallback to old function if present
      if(_oldPlaySfx){
        try{ _oldPlaySfx(type); return; }catch(e){}
      }
      _playTone(700, 0.06);
      return;
    }

    if(type && typeof type === 'object'){
      if(type.pattern) { _playPattern(type.pattern); return; }
      if(type.f || type.freq) { _playPattern([type]); return; }
    }
  }catch(e){
    console.warn('playSfx error', e);
    if(_oldPlaySfx) try{ _oldPlaySfx(type); }catch(e){}
  }
}

// helper: programmatic APIs
window.setDefaultClickSfx = function(name){ window.DEFAULT_CLICK_SFX = name; };
window.playClick = function(){ window.playSfx(window.DEFAULT_CLICK_SFX || 'click'); };

// Attach data-sfx attr: elements with data-sfx="pop" will play that preset on click
window.attachSfxToElements = function(selector = '[data-sfx]', attr = 'data-sfx'){
  try{
    document.querySelectorAll(selector).forEach(el=>{
      if(el.__sfxBound) return;
      el.addEventListener('click', ev=>{
        const s = el.getAttribute(attr) || 'click';
        try{ window.playSfx(s); }catch(e){}
      }, {passive:true});
      el.__sfxBound = true;
    });
  }catch(e){}
};

/**
 * Special mappings for common controls (logout, sound toggle, theme toggle).
 * This will bind a different sound to common selectors if present in your DOM.
 * If an element already has data-sfx, that takes precedence and will NOT be overridden.
 */
function attachSpecialSfxMappings(){
  const mappings = [
    // logout / sign out actions -> punch (assertive)
    {selectors: ['#logout','#logoutBtn','.logout','[data-action="logout"]','.btn-logout','#btnLogout'], sfx: 'punch'},
    // sound on/off / mute toggle -> toggle (pop-like)
    {selectors: ['#soundToggle','.sound-toggle','[data-action="soundToggle"]','[data-action="toggle-sound"]','#btnSound'], sfx: 'toggle'},
    // theme / dark-light toggle -> theme (bell-ish)
    {selectors: ['#themeToggle','.theme-toggle','[data-action="themeToggle"]','[data-action="toggle-theme"]','#btnTheme','[data-action="darkLight"]'], sfx: 'theme'},
    // additional: settings close or logout-confirm -> pop
    {selectors: ['.signout','.logout-confirm','#signOut'], sfx: 'pop'}
  ];

  mappings.forEach(map=>{
    map.selectors.forEach(sel=>{
      document.querySelectorAll(sel).forEach(el=>{
        // if element has explicit data-sfx, respect it
        if(el.getAttribute && el.getAttribute('data-sfx')) return;
        if(el.__specialSfxBound) return;
        el.addEventListener('click', ev=>{
          try{ window.playSfx(map.sfx); }catch(e){}
        }, {passive:true});
        el.__specialSfxBound = true;
      });
    });
  });
}

// auto-bind data-sfx and special mappings once DOM ready
(function autoBindWhenReady(){
  function doBind(){
    try{
      attachSfxToElements();        // binds any data-sfx items
      attachSpecialSfxMappings();   // binds known selectors (logout/toggles)
    }catch(e){}
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', doBind, { once:true });
  } else {
    doBind();
  }
})();

/* ========== PREFERRED VOICE INIT (tries to avoid Google-labelled voices) ========= */
window.PREFERRED_VOICE = null;
(function initPreferredVoice(prefLangPrefix = 'en') {
  const synth = window.speechSynthesis;
  if(!synth) return;
  function pick(langPref = prefLangPrefix){
    const voices = synth.getVoices() || [];
    if(!voices.length) return;
    // prefer voices that do NOT include "google" in the name
    const nonGoogle = voices.filter(v => !/google/i.test(v.name));
    // try to find same language in non-google list, else fall back
    let voice = (nonGoogle.find(v => v.lang && v.lang.toLowerCase().startsWith(langPref))
                 || nonGoogle[0]
                 || voices.find(v => v.lang && v.lang.toLowerCase().startsWith(langPref))
                 || voices[0]) || null;
    window.PREFERRED_VOICE = voice;
  }
  pick(prefLangPrefix);
  if (typeof synth.onvoiceschanged !== 'undefined') {
    synth.onvoiceschanged = ()=> pick(prefLangPrefix);
  }
})();
/* ========== TTS (updated to prefer non-Google voices where possible + underscore → blank) ========= */
function speak(text, {rate=1, pitch=1, interrupt=false, lang='en-US'} = {}) {
  if(!state.voiceOn) return null;
  const synth = window.speechSynthesis;
  if(!synth) return null;
  try{
    if(interrupt) synth.cancel();

    // Work on a safe copy of the text
    let t = String(text || '').trim();
    if(!t) return null;

    // Normalization (conservative & targeted)
    try{
      const idx = t.toLowerCase().lastIndexOf(' for ');
      if(idx !== -1){
        let prefix = t.slice(0, idx).trim();
        let rest = t.slice(idx + 5).trim();

        const letterDup = prefix.match(/^([A-Za-z])(?:\.\s*|\s+)\1$/i) || prefix.match(/^([A-Za-z])\1$/i);
        if(letterDup){
          prefix = letterDup[1].toUpperCase();
        } else if(/^[a-z]$/.test(prefix)){
          prefix = prefix.toUpperCase();
        }

        const dupRest = rest.match(/^(.+)\s+\1$/i);
        if(dupRest && dupRest[1]) rest = dupRest[1].trim();

        t = prefix ? `${prefix} for ${rest}` : `for ${rest}`;
      } else {
        const letterDup2 = t.match(/^\s*([A-Za-z])(?:\.\s*|\s+)\1\s*(.*)$/i);
        if(letterDup2){
          const L = letterDup2[1].toUpperCase();
          const rest2 = (letterDup2[2] || '').trim();
          t = rest2 ? `${L} ${rest2}` : L;
        }
      }

      // squash multiple spaces
      t = t.replace(/\s{2,}/g, ' ').trim();

      // 🔥 DEEP-THINK UPDATE: convert underscores to "blank"
      t = t.replace(/_{2,}/g, ' blank '); // double or more underscores
      t = t.replace(/_/g, ' blank ');     // single underscore

    }catch(e){
      t = String(text || '').trim();
    }

    const utter = new SpeechSynthesisUtterance(String(t));
    utter.rate = rate; 
    utter.pitch = pitch; 
    utter.lang = lang;

    // Use preferred non-Google voice if available
    if(window.PREFERRED_VOICE && window.PREFERRED_VOICE.name && !/google/i.test(String(window.PREFERRED_VOICE.name))){
      try{
        const pv = window.PREFERRED_VOICE;
        if(!pv.lang || String(pv.lang).toLowerCase().startsWith(String(lang).slice(0,2).toLowerCase())){
          utter.voice = pv;
        }
      }catch(e){ /* fail gracefully */ }
    }

    synth.speak(utter);
    return utter;
  }catch(e){ return null; }
}


/**
 * listenOnce(lang = "en-US", timeoutMs = 8000)
 * - returns a Promise that resolves with the transcript string or rejects with an Error
 * - guarantees resolution (resolve/reject) so handlers using finally() always run
 * - includes a safety timeout to avoid stuck states
 */
function listenOnce(lang="en-US", timeoutMs = 8000){
  return new Promise((resolve, reject) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SR) return reject(new Error("SpeechRecognition unsupported"));
    const rec = new SR();
    let finished = false;
    let timer = null;

    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      finished = true;
      try{ rec.stop(); }catch(e){}
      if(timer) clearTimeout(timer);
      try{
        const transcript = (e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript) || "";
        resolve(transcript);
      }catch(err){
        reject(err || new Error("Failed to read recognition result"));
      }
    };

    rec.onerror = (e) => {
      finished = true;
      if(timer) clearTimeout(timer);
      try{ rec.stop(); }catch(e){}
      reject(e && (e.error || e) ? (e.error || e) : new Error("Speech recognition error"));
    };

    // If recognition ends without having received a result or error, treat it as "no speech"
    rec.onend = () => {
      if(!finished){
        if(timer) clearTimeout(timer);
        reject(new Error("No speech detected"));
      }
    };

    // Safety timeout: in case the browser doesn't fire onend/onerror/onresult
    timer = setTimeout(() => {
      if(!finished){
        try{ rec.stop(); }catch(e){}
        reject(new Error("Listening timed out"));
      }
    }, timeoutMs);

    try {
      rec.start();
    } catch(err) {
      if(timer) clearTimeout(timer);
      reject(err);
    }
  });
}


/* ========== UTILS ========= */
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])); }
function escapeHtmlAttr(s){ return escapeHtml(s).replace(/"/g,"&quot;"); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function delay(ms){ return new Promise(r=>setTimeout(r, ms)); }
function todayKey(){ const d = new Date(); d.setHours(0,0,0,0); return d.toISOString().slice(0,10); }
/* ---------- pickDailyIndexes (deterministic daily selection) ----------
   Returns an array of `count` unique indexes from 0..(poolSize-1).
   Selection is deterministic per-day per-key (id) using a seeded PRNG and cached in localStorage.
*/
function pickDailyIndexes(poolSize, count, id){
  count = Math.min(Math.max(0, Number(count)||0), Number(poolSize)||0);
  if(count <= 0) return [];
  const today = (new Date()).toISOString().slice(0,10);
  const key = `brx_daily_${String(id||'')}_${today}_${poolSize}_${count}`;
  try{
    const raw = localStorage.getItem(key);
    if(raw){
      const arr = JSON.parse(raw);
      if(Array.isArray(arr) && arr.length===count) return arr;
    }
  }catch(e){ /* ignore */ }

  // simple deterministic hash from id + date
  const seedStr = String(id||'') + '|' + today + '|' + String(poolSize) + '|' + String(count);
  let h = 2166136261 >>> 0;
  for(let i=0;i<seedStr.length;i++){
    h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619) >>> 0;
  }
  // mulberry32-like generator
  function rand(){
    h = (h + 0x6D2B79F5) >>> 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  const arr = Array.from({length: poolSize}, (_,i)=>i);
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(rand()*(i+1));
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  const picked = arr.slice(0, count);
  try{ localStorage.setItem(key, JSON.stringify(picked)); }catch(e){}
  return picked;
}


/* ========== LOCAL STORAGE PROFILE ========= */
function saveLocal(){
  const k = `brainrootx_profile_${state.user?.uid||'local'}`;   // updated key
  const data = {
    user: state.user,
    streakDays: state.streakDays,
    lastStreakDate: state.lastStreakDate,
  };
  localStorage.setItem(k, JSON.stringify(data));
}
function loadLocal(uid='local'){
  const k = `brainrootx_profile_${uid}`;   // updated key
  const raw = localStorage.getItem(k);
  if(!raw) return;
  try{ 
    const data = JSON.parse(raw); 
    state.streakDays = data.streakDays||0; 
    state.lastStreakDate = data.lastStreakDate||null; 
  }catch{}
}


/* ========== DAILY (completed + claimed) ========= */
function dailyKey(){ return `brainrootx_daily_${state.user?.uid||'local'}`; }   // updated key
function getDailyState(){
  const raw = localStorage.getItem(dailyKey());
  const today = todayKey();
  if(!raw) return { date: today, completed: 0, claimed: false };
  try{
    const obj = JSON.parse(raw);
    if(obj.date !== today) return { date: today, completed: 0, claimed: false };
    return obj;
  }catch(e){ return { date: today, completed: 0, claimed: false }; }
}
function setDailyState(obj){
  obj.date = todayKey();
  localStorage.setItem(dailyKey(), JSON.stringify(obj));
}


/* ========== SUPABASE (replaces Firebase) ========== */
/* Paste your Supabase project URL & anon key below */
const SUPABASE_URL = 'https://ayzlvaeyrqupbtthdihg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5emx2YWV5cnF1cGJ0dGhkaWhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4ODg0MzUsImV4cCI6MjA3NDQ2NDQzNX0.cXPjZUG-boa87lxTFoFVVNFCdsR0gwTvTLnotOiGlJA';
let supabase = null;

async function fetchAndSetProfile(user){
  if(!supabase || !user) return;
  try{
    // try to fetch profile row (profiles.id == auth.user.id)
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if(profile){
      state.user = {
        uid: user.id,
        name: profile.name || (user.user_metadata?.name || 'Learner'),
        email: user.email,
        username: profile.username || ''
      };
      state.streakDays = profile.streak_days || state.streakDays || 0;
      state.lastStreakDate = profile.last_streak_date || state.lastStreakDate || null;
    } else {
      // create lightweight profile if missing
      const name = user.user_metadata?.full_name || user.user_metadata?.name || (user.email||'').split('@')[0];
      const username = generateUsernameFromName(name);
      await supabase.from('profiles').insert({
        id: user.id,
        name,
        email: user.email,
        username,
        streak_days: 0
      }).throwOnError();
      state.user = { uid: user.id, name, email: user.email, username };
    }
    loadLocal(user.id);
  }catch(e){
    console.warn('fetchAndSetProfile error', e);
  }
}

async function initSupabase(){
  try{
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm');
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // check current session (on page load)
    try{
      const { data } = await supabase.auth.getSession();
      const session = data?.session;
      if(session && session.user){
        await fetchAndSetProfile(session.user);
        enterApp();
        refreshAuthUI();
      } else {
        showScreen('auth');
        refreshAuthUI();
      }
    }catch(e){
      console.warn('Supabase getSession failed', e);
      showScreen('auth');
      refreshAuthUI();
    }

    // subscribe to auth changes
    supabase.auth.onAuthStateChange(async (event, session) => {
      if(session && session.user){
        await fetchAndSetProfile(session.user);
        enterApp();
        refreshAuthUI();
      }else{
        state.user = null;
        showScreen('auth');
        refreshAuthUI();
      }
    });

  }catch(e){
    console.warn('Supabase init failed', e);
    showScreen('auth');
  }
}
initSupabase();

/* ========== AUTH UI (Supabase) ========= */

/* username validation state */
let usernameValid = false;

/* Helper: enable/disable Create Account button
   require a valid username + email + password length >= 6
*/
function updateCreateBtn(){
  const btn = document.getElementById('createAccountBtn');
  if(!btn) return;
  const emailVal = document.querySelector('#signupForm input[name="email"]')?.value.trim();
  const pwdVal = document.querySelector('#signupForm input[name="password"]')?.value || '';
  btn.disabled = !(usernameValid && emailVal && pwdVal.length >= 6);
}

function setupAuthUI(){
  // warn if supabase not initialised
  if(typeof supabase === 'undefined' || !supabase?.auth){
    console.warn('Supabase client not found — ensure you initialized supabase (createClient) in your optional block.');
  }

  // tabs logic (if tabs exist)
  const tabs = $$('.tab');
  const panels = $$('.tabpanel');
  tabs.forEach(t=>{
    t.addEventListener('click', ()=>{
      tabs.forEach(x=>x.classList.remove('active'));
      panels.forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      const id = t.dataset.tab;
      const p = $(`#${id}Form`);
      if(p) p.classList.add('active');
      playSfx('click');
    });
  });

  /* ---------- helper: fetch or create profile for a user ---------- */
  async function fetchAndSetProfile(user){
    if(!user || !supabase) return;
    try{
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if(error) throw error;

      if(profile){
        state.user = {
          uid: user.id,
          name: profile.name || (user.user_metadata?.name || user.email?.split('@')[0] || ''),
          email: user.email,
          username: profile.username || ''
        };
        state.streakDays = profile.streak_days || 0;
        state.lastStreakDate = profile.last_streak_date || null;
      } else {
        // create lightweight profile if missing
        const name = user.user_metadata?.name || user.user_metadata?.full_name || (user.email||'').split('@')[0];
        const username = user.user_metadata?.username || generateUsernameFromName(name);
        await supabase.from('profiles').upsert({
          id: user.id,
          name,
          email: user.email,
          username,
          streak_days: 0
        });
        state.user = { uid: user.id, name, email: user.email, username };
      }
      loadLocal(user.id);
    }catch(e){
      console.warn('fetchAndSetProfile error', e);
    }
  }

  /* ---------- Signup form (email/password + username) ---------- */
  $('#signupForm')?.addEventListener('submit', async (e)=>{
    e.preventDefault(); playSfx('click');

    // require a valid username
    const username = (e.target.username?.value || '').trim().toLowerCase();
    if(!usernameValid || !username){
      alert("Please choose a valid username before creating account.");
      return;
    }

    const name = e.target.name.value.trim();
    const email = e.target.email.value.trim();
    const password = e.target.password.value;

    // local fallback (no supabase)
    if(!supabase || !supabase.auth){
      state.user = { uid:"local", name, email, username };
      loadLocal("local");
      enterApp();
      refreshAuthUI();
      return;
    }

    try{
      // sign up on Supabase (puts name/username into user_metadata too)
      const res = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name, username } }
      });
      if(res.error) throw res.error;

      // Supabase may or may not return a session immediately depending on email confirm settings
      const user = res.data?.user || res.data?.session?.user;
      if(user){
        // create or update profile row
        await supabase.from('profiles').upsert({
          id: user.id,
          name,
          email,
          username,
          streak_days: 0
        });
        state.user = { uid: user.id, name, email, username };
        loadLocal(user.id);
        enterApp();
        refreshAuthUI();
      }else{
        // likely email confirmation required
        alert('A confirmation email was sent. Please confirm your email and then log in.');
      }
    }catch(err){
      alert(err.message || err);
    }
  });

  /* ---------- Login (modal or legacy) ---------- */
  const loginModal = document.getElementById('loginModal');
  const openLoginLink = document.getElementById('openLoginLink');
  const closeLoginModal = document.getElementById('closeLoginModal');

  // prefer modal if present, else fallback to legacy #loginForm
  const loginForm = document.getElementById('loginFormModal') || document.getElementById('loginForm');

  if(openLoginLink){
    openLoginLink.addEventListener('click', (ev)=>{
      ev.preventDefault();
      playSfx('click');
      if(loginModal) { loginModal.classList.remove('hidden'); loginModal.setAttribute('aria-hidden','false'); }
      else {
        // fallback: switch to login tab if it exists
        const loginTab = document.querySelector('.tab[data-tab="login"]');
        if(loginTab) loginTab.click();
      }
    });
  }
  if(closeLoginModal){
    closeLoginModal.addEventListener('click', ()=>{
      playSfx('click');
      if(loginModal) { loginModal.classList.add('hidden'); loginModal.setAttribute('aria-hidden','true'); }
    });
  }

  if(loginForm){
    loginForm.addEventListener('submit', async (e)=>{
      e.preventDefault(); playSfx('click');
      const email = e.target.email.value.trim();
      const password = e.target.password.value;

      if(!supabase || !supabase.auth){
        state.user = { uid:"local", name: email.split('@')[0], email };
        loadLocal("local");
        enterApp();
        if(loginModal) { loginModal.classList.add('hidden'); }
        refreshAuthUI();
        return;
      }

      try{
        const res = await supabase.auth.signInWithPassword({ email, password });
        if(res.error) throw res.error;
        const user = res.data?.user;
        if(user){
          await fetchAndSetProfile(user);
        }
        if(loginModal) { loginModal.classList.add('hidden'); }
      }catch(err){
        alert(err.message || err);
      }
    });
  }

  /* demo login */
  const demoLoginModal = document.getElementById('demoLoginModal') || document.getElementById('demoLogin');
  if(demoLoginModal){
    demoLoginModal.addEventListener('click', ()=>{
      playSfx('click');
      state.user = { uid:"local", name:"Guest", email:"" };
      loadLocal("local");
      enterApp();
      if(document.getElementById('loginModal')) document.getElementById('loginModal').classList.add('hidden');
      refreshAuthUI();
    });
  }

  /* ---------- Social sign-in (Google + Facebook) ---------- */
  const googleBtn = document.getElementById('googleSignBtn');
  const fbBtn = document.getElementById('fbSignBtn');

  async function socialSignIn(providerName){
    if(!supabase || !supabase.auth){
      alert("Supabase not ready for social sign-in.");
      return;
    }
    try{
      // Triggers redirect to provider. on return, your supabase auth listener should handle session.
      await supabase.auth.signInWithOAuth({
        provider: providerName,
        options: { redirectTo: window.location.origin }
      });
    }catch(err){
      alert(err.message || err);
    }
  }

  if(googleBtn) googleBtn.addEventListener('click', ()=> socialSignIn('google'));
  if(fbBtn) fbBtn.addEventListener('click', ()=>{
  playSfx('click');
  alert("🚧 Facebook sign-in is coming soon!");
});

  /* ---------- Logout handler ---------- */
  $('#logoutBtn')?.addEventListener('click', async ()=>{
    playSfx('click');
    if(supabase && supabase.auth){
      try{ await supabase.auth.signOut(); }catch(e){ console.warn(e); }
    }
    state.user = null;
    showScreen("auth");
    refreshAuthUI();
  });
}
setupAuthUI();

/* ===== EXTRA AUTH FEATURES (username + Save) ===== */

// Generate username suggestion from full name
function generateUsernameFromName(fullName){
  const base = fullName.trim().toLowerCase()
    .replace(/\s+/g, '')     // remove spaces
    .replace(/[^a-z0-9]/g,''); // only a-z0-9
  const rand = Math.floor(Math.random()*900 + 100); // 100-999
  return base ? `${base}${rand}` : '';
}

// Check Supabase 'profiles' table if username is unique
async function isUsernameAvailable(username){
  if(!supabase || !supabase.from) return true; // assume available in local mode
  try{
    const { data, error } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', username)
      .limit(1);

    if(error){
      console.warn('username check error', error);
      return true; // fail-open so signups don't get blocked
    }
    return !(data && data.length > 0);
  }catch(err){
    console.warn('Username check failed', err);
    return true; // fail open
  }
}

// Auto-generate username when user types full name
$('#signupForm input[name="name"]')?.addEventListener('input', async (e)=>{
  const fullName = e.target.value;
  const usernameInput = $('#usernameInput');
  const status = $('#usernameStatus');
  if(!usernameInput || !status) return;

  if(fullName.trim().length < 3){
    usernameInput.value = '';
    status.textContent = '';
    usernameValid = false;
    updateCreateBtn();
    return;
  }

  let suggestion = generateUsernameFromName(fullName);
  let tries = 0;
  while(!(await isUsernameAvailable(suggestion)) && tries < 5){
    suggestion = generateUsernameFromName(fullName);
    tries++;
  }

  usernameInput.value = suggestion;
  status.textContent = 'Username available ✅';
  status.style.color = 'green';
  usernameValid = true;
  updateCreateBtn();
});

// Validate when user edits username manually
$('#usernameInput')?.addEventListener('input', async (e)=>{
  const val = e.target.value.trim();
  const status = $('#usernameStatus');
  if(!status) return;
  if(val.length < 3){
    status.textContent = 'Too short';
    status.style.color = 'red';
    usernameValid = false;
    updateCreateBtn();
    return;
  }
  if(!/^[a-z0-9]+$/.test(val)){
    status.textContent = 'Only lowercase letters and digits allowed';
    status.style.color = 'red';
    usernameValid = false;
    updateCreateBtn();
    return;
  }

  if(await isUsernameAvailable(val)){
    status.textContent = 'Username available ✅';
    status.style.color = 'green';
    usernameValid = true;
  }else{
    status.textContent = 'Already taken ❌';
    status.style.color = 'red';
    usernameValid = false;
  }
  updateCreateBtn();
});


/* ===== NOTE: OTP FLOW REMOVED =====
   All phone/OTP/recaptcha code and buttons were intentionally removed.
   Create account now depends on usernameValid + email + password.
*/

/* ========== UI HELPERS (Supabase-aware) ========= */

function refreshAuthUI(){
  const logout = $('#logoutBtn');
  if(!logout) return;
  logout.style.display = state.user ? 'inline-flex' : 'none';

  // Optionally update a small header indicator (if exists)
  const headerUser = $('#headerUser');
  if(headerUser){
    if(state.user){
      headerUser.textContent = state.user.username ? `@${state.user.username}` : (state.user.name || state.user.email || '');
      headerUser.classList.remove('hidden');
    }else{
      headerUser.textContent = '';
      headerUser.classList.add('hidden');
    }
  }
}

/* Ensure header state on load */
refreshAuthUI();

/* ===== SAVE / SIGNUP (old second sign-up handler removed and merged above) ===== */
/* signup flow handled in setupAuthUI() */

/* ===== ENTER APP (simple safe default) ===== */
/* If you already have a richer enterApp() replace this. */
function enterApp(){
  $('#greetText').innerHTML = `Hi ${escapeHtml(state.user?.name||"Learner")}! I’m <span class="accent">BrainRootX</span> 👋`;
  updateStreakUI();
  injectModuleIllustrations?.();
  stopSpeaking();
  speak(`Hello ${state.user?.name||"Learner"}! Welcome to BrainRootX. Let's learn something fun today!`, { interrupt:true });
  showScreen("menu");
}


/* ========== NAV ========= */
$$('.nav').forEach(btn=>{
  btn.addEventListener('click',()=>{
    playSfx('click');

    // Check if this is a locked button
    if(btn.dataset.locked){
      // show "Coming Soon" popup instead of opening screen
      alert("🚧 This feature is coming soon!");
      return;
    }

    // Otherwise go to target screen
    showScreen(btn.dataset.target);
  });
});

$$('.menu-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    playSfx('click');
    showScreen("menu");
  });
});

$('#voiceToggle')?.addEventListener('click', ()=>{
  state.voiceOn = !state.voiceOn;
  $('#voiceToggle').textContent = state.voiceOn ? "🔊 Voice ON" : "🔇 Voice OFF";
  playSfx('click');
});

/* ========== STREAK SYSTEM (clean fixed version + cloud sync) ========== */

// --- Helpers ---
function dateKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayKey(){ return dateKeyLocal(new Date()); }
function yesterdayKey(){
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return dateKeyLocal(d);
}

// --- Load/save streak state (local) ---
function loadStreakState(){
  try {
    const raw = localStorage.getItem("streakState");
    if(!raw) return { streakDays:0, lastStreakDate:null };
    const obj = JSON.parse(raw);
    return {
      streakDays: obj.streakDays || 0,
      lastStreakDate: obj.lastStreakDate || null
    };
  } catch(e){ return { streakDays:0, lastStreakDate:null }; }
}
function saveStreakState(){
  localStorage.setItem("streakState", JSON.stringify({
    streakDays: state.streakDays || 0,
    lastStreakDate: state.lastStreakDate || null
  }));
}

/* ========== CLOUD SYNC (Supabase) ========== */

/**
 * Save streak + minimal profile data to Supabase 'profiles' table.
 * Falls back to local storage if supabase/client not available or user is "local".
 */
async function saveToCloud(){
  try{
    // Always persist locally first
    saveStreakState();

    if(!window.supabase || !supabase?.from || !state.user || state.user.uid === 'local') return;

    const payload = {
      id: state.user.uid,
      name: state.user.name || null,
      email: state.user.email || null,
      username: state.user.username || null,
      streak_days: state.streakDays || 0,
      last_streak_date: state.lastStreakDate || null
    };

    // Use upsert so a missing row will be created and existing will be updated
    const { error } = await supabase.from('profiles').upsert(payload, { returning: 'minimal' });
    if(error) console.warn('saveToCloud error:', error);
  }catch(err){
    console.warn('saveToCloud exception', err);
  }
}

/**
 * Load streak-related fields from Supabase (if available) and merge into local state.
 * This is run on login and on page init (when there is an auth user).
 */
async function loadStreakFromCloud(){
  try{
    if(!window.supabase || !supabase?.from || !state.user || state.user.uid === 'local') return;

    const { data, error } = await supabase
      .from('profiles')
      .select('streak_days, last_streak_date')
      .eq('id', state.user.uid)
      .maybeSingle();

    if(error){
      console.warn('loadStreakFromCloud error', error);
      return;
    }

    if(data){
      // last_streak_date may be null or a string like '2025-09-27'
      state.streakDays = Number(data.streak_days || 0);
      state.lastStreakDate = data.last_streak_date ? String(data.last_streak_date).slice(0,10) : null;
      // persist locally as canonical cache
      saveStreakState();
      updateStreakUI();
    }
  }catch(err){
    console.warn('loadStreakFromCloud exception', err);
  }
}

/* Optional: try to load cloud streak after successful sign-in events.
   This uses supabase's auth listener if available. It's safe to call multiple times.
*/
if(window.supabase && supabase?.auth && typeof supabase.auth.onAuthStateChange === 'function'){
  try{
    supabase.auth.onAuthStateChange((event, session) => {
      if(session?.user){
        // small delay to let other sign-in flows finish (UI, profile fetch)
        setTimeout(()=> loadStreakFromCloud(), 250);
      }
    });
  }catch(e){ /* ignore */ }
}

// --- Update UI ---
function updateStreakUI(){
  $('#streakCount').textContent = state.streakDays || 0;
  const today = todayKey();
  state.todayDone = (state.lastStreakDate === today);
  $('#todayStatus').textContent = state.todayDone ? "Completed 🎉" : "Pending";
}

// --- Claim today ---
function markTodayComplete(){
  const today = todayKey();
  if(state.lastStreakDate === today){
    state.todayDone = true;
    return;
  }

  if(state.lastStreakDate === yesterdayKey()){
    state.streakDays = (state.streakDays || 0) + 1;
  } else {
    state.streakDays = 1; // reset if gap
  }

  state.lastStreakDate = today;
  state.todayDone = true;

  updateStreakUI();
  saveStreakState();
  // persist to cloud (best-effort)
  saveToCloud();
}

// --- Modal ---
function showStreakModal(day){
  const modal = $('#streakModal');
  if(!modal) return;
  $('#streakDay').textContent = `Day ${day}`;
  $('#streakText').textContent = `You finished a quiz — claim your Day ${day} streak!`;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  playSfx('cheer');
  stopSpeaking();
}
function hideStreakModal(){
  const modal = $('#streakModal');
  if(!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

// --- Claim button ---
$('#streakClaimBtn')?.addEventListener('click', ()=>{
  playSfx('click');
  stopSpeaking();

  markTodayComplete();

  hideStreakModal();
  playSfx('cheer');
  speak('Streak claimed! Great job.', { interrupt:true });

  renderLeaderboard();
});

// --- Claim later ---
$('#streakLaterBtn')?.addEventListener('click', ()=>{
  playSfx('click');
  hideStreakModal();
});

// --- Record quiz completion ---
function recordQuizCompletion(source){
  const today = todayKey();
  if(state.lastStreakDate !== today){
    const upcomingDay = (state.streakDays || 0) + 1;
    setTimeout(()=> showStreakModal(upcomingDay), 700);
  }
}

// --- Init on page load ---
(async function initStreak(){
  const s = loadStreakState();
  state.streakDays = s.streakDays;
  state.lastStreakDate = s.lastStreakDate;

  // If the user is already signed in and supabase is available, prefer cloud value
  if(window.supabase && state.user && state.user.uid && state.user.uid !== 'local'){
    await loadStreakFromCloud();
  }else{
    updateStreakUI();
  }
})();


/* ========== LEADERBOARD ========= */
async function renderLeaderboard(){
  const wrap = $('#leaderWrap');
  if(!wrap) return;
  wrap.innerHTML = `<p class="muted">Loading leaderboard…</p>`;

  let rows = [];
  if(state.firebase.db){
    try{
      const {collection, getDocs, query, orderBy, limit} = state.firebase._mods.dbMod;
      const q = query(collection(state.firebase.db,'leaderboard'), orderBy('streak','desc'), limit(50));
      const snap = await getDocs(q);
      rows = snap.docs.map(d=>{ const data = d.data()||{}; data._displayStreak = (data.lastStreakDate && (new Date(data.lastStreakDate) < (new Date(new Date().setDate(new Date().getDate()-1)))) ) ? 0 : (data.streak||0); return data; });
    }catch(e){ console.warn("leaderboard cloud error", e); }
  }

  if(!rows.length){
    rows = [
      {username:"Aarav", streak:12},
      {username:"Zoya", streak:9},
      {username:"Kabir", streak:7},
      {username: state.user?.name||"You", streak: state.streakDays||0 },
      {username:"Mia", streak:4},
      {username:"Ishaan", streak:3},
    ];
  }

  const meIdx = rows.findIndex(r=>(r.username||"")===state.user?.name);
  if(meIdx<0) rows.push({username: state.user?.name||"You", streak: state.streakDays||0});

  rows.sort((a,b)=> (b.streak||0) - (a.streak||0));
  wrap.innerHTML = rows.map((r,i)=>{
    const medal = i===0?"🥇":i===1?"🥈":i===2?"🥉":"";
    const top = i<3 ? "top" : "";
    return `<div class="row ${top}">
      <div>${medal?`<span class="medal">${medal}</span>`:""} <b>${escapeHtml(r.username||"User")}</b></div>
      <div>${r.streak||0} days</div>
    </div>`;
  }).join("");
}
document.querySelector('[data-target="leaderboard"]')?.addEventListener('click', renderLeaderboard);


/* ========== SAVE TO CLOUD (leaderboard + streak) ========== */
async function saveToCloud(){
  if(!state.firebase.db || !state.user?.uid || state.user.uid==="local") { saveLocal(); return; }
  try{
    const {doc, setDoc } = state.firebase._mods.dbMod;
    await setDoc(state.firebase._mods.dbMod.doc(state.firebase.db, "users", state.user.uid), {
      name: state.user.name||"",
      email: state.user.email||"",
      streakDays: state.streakDays||0,
      lastStreakDate: state.lastStreakDate||null,
      updatedAt: Date.now()
    }, { merge:true });

    await setDoc(state.firebase._mods.dbMod.doc(state.firebase.db, "leaderboard", state.user.uid), {
      username: state.user.name||"Learner",
      streak: state.streakDays||0,
      updatedAt: Date.now(),
      lastStreakDate: state.lastStreakDate||null,
      updatedAt: Date.now()
    }, { merge:true });
  }catch(e){ console.warn("saveToCloud error", e); }
}

/* ========== DICTIONARY (SHOW HINDI ONLY ON DEMAND) ========== */
(function(){

  const HIST_KEY = 'brx_dict_history_v1';
  const FAV_KEY  = 'brx_dict_favs_v1';
  const MAX_HISTORY = 30;
  const JOIN_TOKEN = '\n|||---|||';

  const dictForm = $('#dictForm');
  const dictInput = $('#dictInput');
  const dictVoice = $('#dictVoice');
  const dictResult = $('#dictResult');
  const dictTranslate = document.getElementById('dictTranslate');
  const dictTransResult = document.getElementById('dictTransResult');
  const dictAutoSpeak = document.getElementById('dictAutoSpeak');

  // ensure a history/favs container exists
  let dictMetaWrap = $('#dictMetaWrap');
  if(!dictMetaWrap){
    dictMetaWrap = document.createElement('div');
    dictMetaWrap.id = 'dictMetaWrap';
    dictMetaWrap.className = 'card';
    dictMetaWrap.style.marginTop = '10px';
    if(dictResult && dictResult.parentNode) dictResult.parentNode.appendChild(dictMetaWrap);
    else document.querySelector('#dictionary .card')?.appendChild(dictMetaWrap);
  }

  // aria-live region
  let liveRegion = document.getElementById('dictLiveRegion');
  if(!liveRegion){
    liveRegion = document.createElement('div');
    liveRegion.id = 'dictLiveRegion';
    liveRegion.setAttribute('aria-live','polite');
    liveRegion.style.position = 'absolute';
    liveRegion.style.left = '-9999px';
    liveRegion.style.width = '1px';
    liveRegion.style.height = '1px';
    liveRegion.style.overflow = 'hidden';
    document.body.appendChild(liveRegion);
  }

  // ---------- storage helpers ----------
  function readHistory(){ try{ return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); }catch(e){ return []; } }
  function writeHistory(arr){ try{ localStorage.setItem(HIST_KEY, JSON.stringify(arr.slice(0,MAX_HISTORY))); }catch(e){} }
  function addToHistory(word){
    if(!word) return;
    word = String(word).trim();
    if(!word) return;
    const h = readHistory().filter(x=>x !== word);
    h.unshift(word);
    writeHistory(h);
    renderMeta();
  }
  function readFavs(){ try{ return JSON.parse(localStorage.getItem(FAV_KEY) || '{}'); }catch(e){ return {}; } }
  function writeFavs(obj){ try{ localStorage.setItem(FAV_KEY, JSON.stringify(obj||{})); }catch(e){} }
  function toggleFav(word, meta){
    const f = readFavs();
    if(f[word]) { delete f[word]; } else { f[word] = { word, addedAt: Date.now(), meta: meta || {} }; }
    writeFavs(f);
    renderMeta();
  }
  function isFav(word){ const f = readFavs(); return !!f[word]; }

  // ---------- render meta ----------
  function renderMeta(){
    const hist = readHistory();
    const favs = readFavs();
    const favList = Object.keys(favs || {}).slice(0,10);

    dictMetaWrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <strong>Recent searches</strong>
        <div style="display:flex;gap:8px">
          <button id="dictClearHist" class="btn btn-ghost">Clear</button>
        </div>
      </div>
      <div id="dictRecent" class="list" style="margin-top:8px">${hist.length ? hist.slice(0,10).map(w=>`<div class="item" data-word="${escapeHtmlAttr(w)}"><button class="btn btn-ghost hist-word" data-word="${escapeHtmlAttr(w)}">${escapeHtml(w)}</button> <small class="muted"> · </small> <button class="btn btn-ghost fav-toggle" data-word="${escapeHtmlAttr(w)}">${isFav(w)?'★':'☆'}</button></div>`).join('') : `<div class="muted small">No recent searches yet.</div>`}</div>

      <hr class="soft" />

      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>Favorites</strong>
        <div></div>
      </div>
      <div id="dictFavs" class="list" style="margin-top:8px">${favList.length ? favList.map(w=>`<div class="item" data-word="${escapeHtmlAttr(w)}"><button class="btn btn-ghost hist-word" data-word="${escapeHtmlAttr(w)}">${escapeHtml(w)}</button> <small class="muted"> · </small> <button class="btn btn-ghost fav-toggle" data-word="${escapeHtmlAttr(w)}">★</button></div>`).join('') : `<div class="muted small">No favorites yet. Tap the star on a result to save.</div>`}</div>
    `;

    const clearBtn = document.getElementById('dictClearHist');
    if(clearBtn) clearBtn.addEventListener('click', ()=>{ writeHistory([]); renderMeta(); playSfx('pop'); });

    dictMetaWrap.querySelectorAll('.hist-word').forEach(btn=>{
      if(btn.__histBound) return;
      btn.addEventListener('click', ()=>{ const w = btn.dataset.word; if(w) searchWord(w); playSfx('click'); });
      btn.__histBound = true;
    });
    dictMetaWrap.querySelectorAll('.fav-toggle').forEach(btn=>{
      if(btn.__favBound) return;
      btn.addEventListener('click', ()=>{ const w = btn.dataset.word; if(w) toggleFav(w); playSfx('click'); });
      btn.__favBound = true;
    });
  }

  // ---------- pronunciation ----------
  function playPronunciation(audioUrl, text){
    stopSpeaking();
    if(audioUrl){
      let a = document.getElementById('brx-dict-audio');
      if(!a){
        a = document.createElement('audio');
        a.id = 'brx-dict-audio';
        a.style.display = 'none';
        document.body.appendChild(a);
      }
      a.src = audioUrl;
      a.play().catch(()=>{ speak(text || audioUrl, { interrupt:true }); });
      playSfx('pop');
      return;
    }
    if(text) {
      speak(text, { interrupt:true });
      playSfx('pop');
    }
  }

  // ---------- translation batch helper ----------
  async function translateTextBatch(joinedText){
    try{
      const res = await fetch("https://libretranslate.de/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ q: joinedText, source: "en", target: "hi", format: "text" })
      });
      const j = await res.json();
      const translated = j?.translatedText || j?.translated || j?.result || null;
      if(translated) return translated;
    }catch(e){ console.warn('libretranslate failed', e); }

    try{
      const res2 = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(joinedText)}&langpair=en|hi`);
      const d = await res2.json();
      const t = d?.responseData?.translatedText || null;
      if(t) return t;
    }catch(e2){ console.warn('mymemory fallback failed', e2); }

    return null;
  }

  // ---------- attach form submit ----------
  dictForm?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    playSfx('click');
    const word = dictInput.value.trim();
    if(!word) return;
    await searchWord(word);
  });

  // ---------- mic handler ----------
  dictVoice?.addEventListener('click', async ()=>{
    playSfx('click');
    if(!dictVoice) return;
    try{
      dictVoice.disabled = true;
      dictVoice.classList.add('listening');
      dictVoice.textContent = '🎤 Listening...';
      playSfx('nav');

      const transcript = await listenOnce("en-US");
      if(transcript && transcript.trim()){
        dictInput.value = transcript.trim();
        await searchWord(transcript.trim());
      } else {
        alert('No speech detected. Please try again.');
      }
    }catch(err){
      console.warn('dict voice error', err);
      alert('Voice input not available on this device.');
    }finally{
      dictVoice.disabled = false;
      dictVoice.classList.remove('listening');
      dictVoice.textContent = '🎤';
    }
  });

  // ---------- main search + render (ENGLISH ONLY) ----------
  async function searchWord(word){
    if(!word) return;
    const box = dictResult;
    box.innerHTML = `<p class="muted dict-loading">Searching…</p>`;
    if(dictTransResult) dictTransResult.textContent = '';
    liveRegion.textContent = `Searching for ${word}`;

    try{
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      const data = await res.json();
      if(!Array.isArray(data) || !data.length) throw new Error("No result");

      const entry = data[0] || {};
      const phonetic = entry.phonetic || (entry.phonetics?.find(p=>p.text)?.text || "");
      let audioUrl = "";
      if(Array.isArray(entry.phonetics)){
        const candidate = entry.phonetics.find(p => p.audio && p.audio.trim());
        if(candidate) audioUrl = candidate.audio;
      }

      const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];

      // Build ENGLISH-only HTML. Store original texts in data-* attributes for later translation.
      const meaningsHtml = meanings.map((m, mIdx)=>{
        const part = escapeHtml(m.partOfSpeech || '');
        const defs = Array.isArray(m.definitions) ? m.definitions : [];
        const defsHtml = defs.slice(0,3).map((d, dIdx)=>{
          const defText = String(d.definition || '').trim();
          const exText = d.example ? String(d.example).trim() : '';
          const synText = (d.synonyms && d.synonyms.length) ? d.synonyms.slice(0,6).join(', ') : '';
          const idBase = `m${mIdx}d${dIdx}`;
          return `<div class="item" data-def="${escapeHtmlAttr(defText)}" data-ex="${escapeHtmlAttr(exText)}" data-syn="${escapeHtmlAttr(synText)}">
                    <div>• ${escapeHtml(defText)}</div>
                    ${exText ? `<div class="muted small">Example: ${escapeHtml(exText)}</div>` : ''}
                    ${synText ? `<div class="small">Synonyms: ${escapeHtml(synText)}</div>` : ''}
                  </div>`;
        }).join('');
        return `<div class="part"><strong>${part}</strong>${defsHtml}</div>`;
      }).join('');

      const headerHtml = `
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="flex:1">
            <h3 style="margin:0">
              ${escapeHtml(entry.word || word)}
              <small class="muted">${escapeHtml(phonetic||"")}</small>
              <div class="tiny muted" id="brx-hindi-word" data-src="${escapeHtmlAttr(entry.word || word)}" style="margin-top:6px"></div>
            </h3>
            ${entry.origin ? `<div class="tiny muted">Origin: ${escapeHtml(entry.origin)}</div>` : ''}
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost dict-play" data-audio="${escapeHtmlAttr(audioUrl||'')}" title="Play pronunciation">🔊</button>
            <button class="btn btn-ghost dict-fav" data-word="${escapeHtmlAttr(entry.word||word)}" title="${isFav(entry.word||word) ? 'Remove favorite' : 'Save to favorites'}">${isFav(entry.word||word) ? '★' : '☆'}</button>
          </div>
        </div>
      `;

      box.innerHTML = `
        ${headerHtml}
        <div style="margin-top:8px">${meaningsHtml || `<div class="muted">No definitions found.</div>`}</div>
      `;

      // add to history & update UI
      addToHistory(entry.word || word);
      liveRegion.textContent = `${entry.word || word} — ${meanings[0]?.definitions?.[0]?.definition || 'definition available'}`;

      // speak primary definition if auto-speak enabled
      try{
        const primary = meanings[0]?.definitions?.[0]?.definition || entry.word || word;
        if(document.getElementById('dictAutoSpeak')?.checked) {
          speak(`${entry.word || word}. ${primary}`, { interrupt:true });
        }
      }catch(e){}

      playSfx('correct');
      renderMeta();

    }catch(err){
      console.warn('searchWord error', err);
      dictResult.innerHTML = `<p class="muted">Sorry, I couldn't find that word.</p>`;
      liveRegion.textContent = `No result for ${word}`;
      playSfx('wrong');
    }
  }

  // ---------- result buttons handler ----------
  dictResult?.addEventListener('click', (ev)=>{
    const btn = ev.target.closest && ev.target.closest('button');
    if(!btn) return;
    if(btn.classList.contains('dict-play')){
      const audioUrl = btn.dataset.audio;
      const wordText = (dictResult.querySelector('h3')?.textContent || '').split(' ')[0];
      if(audioUrl) playPronunciation(audioUrl, wordText);
      else {
        const primary = dictResult.querySelector('.part .item div')?.textContent || wordText;
        playPronunciation('', primary);
      }
      return;
    }
    if(btn.classList.contains('dict-fav')){
      const w = btn.dataset.word;
      const phon = dictResult.querySelector('h3 small')?.textContent || '';
      toggleFav(w, { phonetic: phon });
      btn.textContent = isFav(w) ? '★' : '☆';
      playSfx('coin');
      renderMeta();
      return;
    }
  });

  renderMeta();
  window.searchWord = searchWord;

  // ---------- Translate button: batch translate only when user clicks ----------
  if(dictTranslate){
    dictTranslate.addEventListener('click', async ()=>{
      playSfx('click');
      const box = dictResult;
      if(!box || !box.querySelector('h3')){ alert('Search a word first before translating.'); return; }

      // prevent duplicate translations: remove old translation nodes
      box.querySelectorAll('.brx-hindi-line').forEach(n => n.remove());
      if(dictTransResult) dictTransResult.textContent = 'Translating…';
      dictTranslate.disabled = true;

      try{
        // collect header and all texts to translate
        const headerEl = box.querySelector('#brx-hindi-word');
        const headerText = headerEl?.dataset?.src || (box.querySelector('h3')?.textContent || '').trim();

        // collect per-item texts in DOM order
        const items = [...box.querySelectorAll('.part .item')];
        const pieces = [headerText];
        items.forEach(it=>{
          const def = it.dataset.def || '';
          const ex = it.dataset.ex || '';
          const syn = it.dataset.syn || '';
          pieces.push(def);
          if(ex) pieces.push(ex);
          if(syn) pieces.push(syn);
        });

        const joined = pieces.join(JOIN_TOKEN);
        const translatedJoined = await translateTextBatch(joined);

        if(!translatedJoined){
          if(dictTransResult) dictTransResult.textContent = 'Translation not available right now.';
          return;
        }

        const parts = translatedJoined.split(JOIN_TOKEN);
        // header translation
        const headerTrans = parts.shift() || '';
        if(headerEl) headerEl.textContent = `Hindi: ${headerTrans}`;

        // iterate again to inject translations
        let idx = 0;
        items.forEach(it=>{
          // def translation
          const defTrans = parts[idx++] || '';
          if(defTrans){
            const node = document.createElement('div');
            node.className = 'muted small brx-hindi-line';
            node.textContent = `Hindi: ${defTrans}`;
            it.appendChild(node);
          }
          // possible example translation
          if(it.dataset.ex){
            const exTrans = parts[idx++] || '';
            if(exTrans){
              const node = document.createElement('div');
              node.className = 'muted tiny brx-hindi-line';
              node.textContent = `Hindi example: ${exTrans}`;
              it.appendChild(node);
            }
          }
          // possible synonyms translation
          if(it.dataset.syn){
            const synTrans = parts[idx++] || '';
            if(synTrans){
              const node = document.createElement('div');
              node.className = 'muted tiny brx-hindi-line';
              node.textContent = `Hindi synonyms: ${synTrans}`;
              it.appendChild(node);
            }
          }
        });

        // optional small status
        if(dictTransResult) dictTransResult.textContent = `Hindi translations added.`;
        playSfx('coin');

        // speak header or primary Hindi if auto-speak enabled
        if(dictAutoSpeak?.checked){
          const speakText = headerTrans || (parts[0] || '');
          if(speakText) speak(speakText, { lang: 'hi-IN', interrupt:true });
        }

      }catch(e){
        console.warn('translate click error', e);
        if(dictTransResult) dictTransResult.textContent = 'Translation failed.';
      }finally{
        dictTranslate.disabled = false;
      }
    });
  }

})(); // end dictionary IIFE

/* ===== BRX English Learning — final interactive module (v-final) ===== */
const brxEnglish = (function () {
  const STORAGE_KEY = 'brx_english_state_v_final';

  const BADGES = [
    { level: 5,  code: 'E', name: 'E Rank', color: '#27ae60', subtitle: 'Starter Rank', emoji: '🌱' },
    { level: 10, code: 'D', name: 'D Rank', color: '#f39c12', subtitle: 'Developing', emoji: '🐣' },
    { level: 16, code: 'C', name: 'C Rank', color: '#3498db', subtitle: 'Competent', emoji: '🥈' },
    { level: 23, code: 'B', name: 'B Rank', color: '#8e44ad', subtitle: 'Brilliant', emoji: '🚀' },
    { level: 30, code: 'A', name: 'A Rank', color: '#ffce00', subtitle: 'Ace', emoji: '🏆' }
  ];

  // persistent state
  let state = {
    xp: 0,
    unlockedLevels: 1,
    levelsBest: {},   // best percent per level
    badgesEarned: []
  };

  // ---------- persistence ----------
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state = Object.assign({}, state, JSON.parse(raw));
    } catch (e) { console.warn('BRX load fail', e); }
  }
  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn('BRX save fail', e); }
  }

  // ---------- DOM helpers ----------
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  function shuffle(arr){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
  function randPick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

  // ---------- XP / costs ----------
  function xpPerCorrect(level){ return 8 + Math.floor(level/5)*2; }
  function unlockCostFor(level){ return 50 + (level - 1) * 10; }

  // ---------- small curated pools (safe) ----------
  const SYN_PAIRS = [
    ['big','large'],['sad','unhappy'],['happy','joyful'],['fast','quick'],
    ['angry','irate'],['rich','wealthy'],['brave','courageous'],['quiet','silent'],
    ['bright','radiant'],['calm','serene'],['easy','simple'],['smart','clever']
  ];
  const ANT_PAIRS = [
    ['hot','cold'],['begin','end'],['light','dark'],['young','old'],['full','empty'],
    ['accept','reject'],['open','close'],['arrive','depart'],['win','lose']
  ];
  const PLURALS = [
    ['mouse','mice'],['child','children'],['foot','feet'],['tooth','teeth'],
    ['person','people'],['man','men'],['goose','geese']
  ];
  const VERB_PAST = [
    ['run','ran'],['go','went'],['eat','ate'],['see','saw'],['write','wrote'],
    ['speak','spoke'],['take','took']
  ];
  const VERBS_3RD = ['go','write','eat','play','run','watch','study','teach','learn','come','speak','read','listen','work','cook'];
  const ARTICLE_AN = ['apple','elephant','orange','ice','hour'];
  const ARTICLE_A = ['dog','car','book','cat','boy','girl','tree','house'];
  const PREP_TEMPLATES = [
    {q:'She is good ___ math.', a:'at'},
    {q:'He depends ___ his family.', a:'on'},
    {q:'We waited ___ the bus.', a:'for'},
    {q:'Think ___ the problem before acting.', a:'about'},
    {q:'I am interested ___ music.', a:'in'}
  ];
  const PRONOUN_OPTIONS = [['they','apple','blue','run'], ['he','dog','book','city'], ['she','banana','car','tree']];
  const FALLBACK_DISTRACTORS = ['other','none','not','a','the','--','maybe','often'];

  // helper: correct 3rd-person form
  function thirdPersonForm(base){
    if (/[^aeiou]y$/.test(base)) return base.slice(0,-1) + 'ies';
    if (/(sh|ch|ss|x|z)$/.test(base)) return base + 'es';
    return base + 's';
  }

  // ensure exactly 4 options and include correct option
  function ensureFourOptions(correct, pool){
    const opts = [correct];
    const candidates = (pool || []).slice().filter(x => x !== correct);
    shuffle(candidates);
    for (let i=0; opts.length<4 && i<candidates.length; i++){
      if (!opts.includes(candidates[i])) opts.push(candidates[i]);
    }
    let k = 0;
    while (opts.length < 4){
      const f = FALLBACK_DISTRACTORS[k % FALLBACK_DISTRACTORS.length];
      if (!opts.includes(f)) opts.push(f);
      k++;
    }
    return shuffle(opts);
  }

  // ---------- build a large curated bank (~400) ----------
  function buildLevelBank(level){
    const bank = [];

    // synonyms
    SYN_PAIRS.forEach(([w,s]) => {
      const pool = SYN_PAIRS.map(p=>p[1]).concat(['small','tiny','little','huge']);
      bank.push({ q:`Synonym of '${w}' is _.`, opts: ensureFourOptions(s, pool), a: null });
    });

    // antonyms
    ANT_PAIRS.forEach(([w,a])=>{
      const pool = ANT_PAIRS.map(p=>p[1]).concat(['big','small','fast','slow']);
      bank.push({ q:`Antonym of '${w}' is _.`, opts: ensureFourOptions(a, pool), a: null });
    });

    // article questions
    ARTICLE_AN.forEach(w=>{
      const correct = /^[aeiou]/i.test(w) ? 'an' : 'a';
      bank.push({ q:`Pick the correct article: I saw ___ ${w}.`, opts: ensureFourOptions(correct,['a','an','the','--']), a:null });
    });
    ARTICLE_A.forEach(w=>{
      const correct = /^[aeiou]/i.test(w) ? 'an' : 'a';
      bank.push({ q:`Pick the correct article: I saw ___ ${w}.`, opts: ensureFourOptions(correct,['a','an','the','--']), a:null });
    });

    // present simple (3rd person)
    VERBS_3RD.forEach(v => {
      const correct = thirdPersonForm(v);
      const pool = [correct, v, v+'ing', v+'ed', 'do'];
      bank.push({ q:`Complete: She ___ every day. (${v})`, opts: ensureFourOptions(correct, pool), a:null });
    });

    // past tense
    VERB_PAST.forEach(([inf,past])=>{
      const pool = VERB_PAST.map(p=>p[1]).concat([inf+'ed','gone','done']);
      bank.push({ q:`Choose the past of '${inf}'.`, opts: ensureFourOptions(past, pool), a:null });
    });

    // plurals
    PLURALS.forEach(([s,p])=>{
      const pool = PLURALS.map(x=>x[1]).concat([s+'s','many','several']);
      bank.push({ q:`Plural of '${s}' is _.`, opts: ensureFourOptions(p, pool), a:null });
    });

    // prepositions / grammar
    PREP_TEMPLATES.forEach(t => bank.push({ q: t.q, opts: ensureFourOptions(t.a, ['in','at','on','for','about','with']), a: null }));

    // pronouns & fills
    PRONOUN_OPTIONS.forEach(opts => bank.push({ q: `Which is a pronoun?`, opts: ensureFourOptions(opts[0], opts), a: null }));
    [['I ___ finished my homework.','have'],['She ___ eaten breakfast.','has']].forEach(([q,c]) => bank.push({ q, opts: ensureFourOptions(c,['have','has','had','having']), a:null }));
    bank.push({ q: `Choose correct word: He speaks ___ English.`, opts: ensureFourOptions('--',['a','an','the','--']), a:null });

    // generate many safe variants for variety (200+)
    const adjectives = ['bright','quiet','brave','calm','rich','strong','sharp','soft','cold','warm','happy','sad'];
    const nouns = ['city','river','teacher','student','book','computer','dog','garden','phone','table','apple','house','car'];
    const verbs = ['play','watch','teach','learn','walk','write','read','cook','sing','dance'];

    for (let i=0;i<250;i++){
      const mode = i % 5;
      if (mode === 0){
        const p = randPick(ANT_PAIRS);
        bank.push({ q:`Antonym of '${p[0]}' is _.`, opts: ensureFourOptions(p[1], ANT_PAIRS.map(x=>x[1]).concat(adjectives)), a:null });
      } else if (mode === 1){
        const p = randPick(SYN_PAIRS);
        bank.push({ q:`Synonym of '${p[0]}' is _.`, opts: ensureFourOptions(p[1], SYN_PAIRS.map(x=>x[1]).concat(nouns)), a:null });
      } else if (mode === 2){
        const v = randPick(verbs);
        const correct = thirdPersonForm(v);
        bank.push({ q:`Complete: She ___ to class. (${v})`, opts: ensureFourOptions(correct, [correct,v,v+'ing',v+'ed']), a:null });
      } else if (mode === 3){
        const n = randPick(nouns.concat(['elephant','orange','hour']));
        const correct = /^[aeiou]/i.test(n) ? 'an' : 'a';
        bank.push({ q:`Pick the correct article: I saw ___ ${n}.`, opts: ensureFourOptions(correct,['a','an','the','--']), a:null });
      } else {
        const p = randPick(PLURALS);
        bank.push({ q:`Plural of '${p[0]}' is _.`, opts: ensureFourOptions(p[1], PLURALS.map(x=>x[1]).concat(['s'+p[0]])), a:null });
      }
    }

    // final safety: ensure ~400 items
    let idx = 0;
    while (bank.length < 400){
      const copy = Object.assign({}, bank[idx % bank.length]);
      copy.q = copy.q + (idx % 7 ? '' : '');
      copy.opts = (copy.opts || []).slice();
      if (copy.opts.length < 4) copy.opts = ensureFourOptions(copy.opts[0] || 'other', copy.opts.concat(FALLBACK_DISTRACTORS));
      bank.push(copy);
      idx++;
      if (idx > 2000) break;
    }

    // finalize: resolve correct indices (populate a field 'a' with index)
    bank.forEach(item => {
      if (typeof item.a !== 'number') {
        // assume the first element in opts that is the intended correct candidate: we used ensureFourOptions which put the 'correct' string as one value
        // try to detect the correct option: prefer words like 'an'/'a' or known lists
        // fallback: pick index 0 as correct (deterministic)
        const possibleCorrects = [].concat(SYN_PAIRS.map(p=>p[1]), ANT_PAIRS.map(p=>p[1]), PLURALS.map(p=>p[1]), VERB_PAST.map(p=>p[1]), ['a','an','the','--']);
        let found = -1;
        for (let i=0;i<item.opts.length;i++){
          if (possibleCorrects.includes(item.opts[i])) { found = i; break; }
        }
        item.a = found >= 0 ? found : 0;
      }
    });

    return shuffle(bank.slice(0,400));
  }

  // cache per-level banks
  const LEVEL_BANKS = {};
  function getLevelBank(level){
    if (!LEVEL_BANKS[level]) LEVEL_BANKS[level] = buildLevelBank(level);
    return LEVEL_BANKS[level];
  }

  // ---------- test management ----------
  let currentTest = null; // { level, questions: [{q,opts,a}], userAnswers: [] }

  function generateTestFor(level){
    const pool = getLevelBank(level).slice();
    shuffle(pool);
    const selected = pool.slice(0,10).map(q => ({ q: q.q, opts: q.opts.slice(), a: q.a }));
    return { level, questions: selected, userAnswers: Array(10).fill(-1) };
  }

  // render test UI (interactive buttons)
  function renderTestQuestions(){
    const qsContainer = $('#brx-test-questions');
    if (!qsContainer || !currentTest) return;
    qsContainer.innerHTML = '';

    // for accessibility clear any previously focused element
    const frag = document.createDocumentFragment();

    currentTest.questions.forEach((item, idx) => {
      const qWrap = document.createElement('div');
      qWrap.className = 'brx-q';

      // Question header
      const qText = document.createElement('div');
      qText.className = 'q-text';
      qText.innerText = `${idx + 1}. ${item.q}`;
      qWrap.appendChild(qText);

      // Options grid
      const optsWrap = document.createElement('div');
      optsWrap.className = 'q-opts';

      // create buttons for each option
      item.opts.forEach((opt, oi) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'q-opt';
        b.setAttribute('data-q', String(idx));
        b.setAttribute('data-val', String(oi));
        b.innerText = opt;
        // click handler: select option visually and store answer
        b.addEventListener('click', () => {
          // if already revealed (after submit), ignore further clicks
          if (qsContainer.dataset.revealed === 'true') return;
          // clear previous selection for this question
          optsWrap.querySelectorAll('.q-opt').forEach(x => x.classList.remove('selected'));
          b.classList.add('selected');
          currentTest.userAnswers[idx] = oi;
          updateTestProgressBar();
        });
        optsWrap.appendChild(b);
      });

      qWrap.appendChild(optsWrap);
      frag.appendChild(qWrap);
    });

    qsContainer.appendChild(frag);

    // reset progress indicators
    qsContainer.dataset.revealed = 'false';
    updateTestProgressBar();

    // scroll test panel to top (panel scroll if present, otherwise window)
    setTimeout(() => {
      const panel = $('#brx-english-test');
      if (panel && typeof panel.scrollTop !== 'undefined') {
        panel.scrollTop = 0;
        panel.focus();
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }, 40);
  }

  // update the small progress bar showing how many answered
  function updateTestProgressBar(){
    const bar = document.querySelector('#brx-test-progressbar span');
    const qsContainer = $('#brx-test-questions');
    if (!bar || !currentTest) return;
    const answered = currentTest.userAnswers.filter(v => v >= 0).length;
    const total = currentTest.questions.length;
    const pct = Math.round((answered / total) * 100);
    bar.style.width = pct + '%';

    // update meta text: show "Answered X / 10" in #brx-test-meta second part
    const metaEl = $('#brx-test-meta');
    if (metaEl) {
      metaEl.innerText = `Answered ${answered}/${total} — pass >= 70%`;
    }
  }

  // open test for level
  function openTest(level){
    currentTest = generateTestFor(level);
    const levelsPanel = $('#brx-english-levels');
    const testPanel = $('#brx-english-test');
    if (levelsPanel) levelsPanel.classList.add('hidden');
    if (testPanel) testPanel.classList.remove('hidden');

    const titleEl = $('#brx-test-title');
    if (titleEl) titleEl.innerText = `Test — Level ${level}`;
    const metaEl = $('#brx-test-meta');
    if (metaEl) metaEl.innerText = `10 Questions — pass >= 70%`;

    renderTestQuestions();
  }

  // close test
  function closeTest(){
    currentTest = null;
    const levelsPanel = $('#brx-english-levels');
    const testPanel = $('#brx-english-test');
    if (testPanel) testPanel.classList.add('hidden');
    if (levelsPanel) levelsPanel.classList.remove('hidden');
    setTimeout(()=> window.scrollTo({ top: 0, behavior: 'smooth' }), 60);
  }

  // reveal answers and show correct/incorrect styling
  function revealAnswersAndMark(answers) {
    const qsContainer = $('#brx-test-questions');
    if (!qsContainer || !currentTest) return;
    qsContainer.dataset.revealed = 'true';
    currentTest.questions.forEach((q, idx) => {
      const opts = qsContainer.querySelectorAll(`.q-opt[data-q="${idx}"]`);
      opts.forEach(btn => {
        const val = Number(btn.dataset.val);
        btn.classList.remove('selected');
        if (val === q.a) {
          btn.classList.add('correct');
        }
        if (answers[idx] >= 0 && answers[idx] !== q.a && val === answers[idx]) {
          btn.classList.add('incorrect');
        }
        // disable buttons after reveal
        btn.disabled = true;
      });
    });
  }

  // submit test
  function submitTest(){
    if (!currentTest) return;

    // gather answers from currentTest.userAnswers
    const answers = currentTest.userAnswers.slice();
    const total = currentTest.questions.length;
    let correctCount = 0;
    for (let i=0;i<total;i++){
      const sel = answers[i];
      if (sel === currentTest.questions[i].a) correctCount++;
    }
    const percent = Math.round((correctCount / total) * 100);

    // compute XP: improvement-based (award only for improvement over previous best)
    const xpEach = xpPerCorrect(currentTest.level);
    const gainedXPFull = xpEach * correctCount;
    const prevBest = state.levelsBest[currentTest.level] || 0;
    let awardedXP = 0;
    if (percent > prevBest) {
      const delta = percent - prevBest;
      awardedXP = Math.max(1, Math.round((gainedXPFull * delta) / 100));
      state.xp += awardedXP;
      state.levelsBest[currentTest.level] = percent;
    }

    // Reveal answers visually
    revealAnswersAndMark(answers);

    // prepare message
    let msg = `Score: ${correctCount}/${total} (${percent}%) — +${awardedXP} XP.`;

    // failing case: percent < 70% -> regenerate fresh test and restart (user requested behavior)
    if (percent < 70) {
      showToast('Score below 70% — regenerating new questions. Try again!', 'warn');
      saveState();
      updateProgress();
      // regenerate new test for same level after a short delay so user sees feedback
      setTimeout(() => {
        currentTest = generateTestFor(currentTest.level);
        renderTestQuestions();
      }, 900);
      const prog = $('#brx-test-progress'); if (prog) prog.innerText = msg + ' Try again!';
      return;
    }

    // success case: pass >= 70%
    const nextLvl = currentTest.level + 1;
    if (nextLvl <= 30) {
      const cost = unlockCostFor(nextLvl);
      if (state.xp >= cost) {
        state.xp -= cost;
        state.unlockedLevels = Math.max(state.unlockedLevels, nextLvl);
        msg += ` 🎉 Level ${nextLvl} unlocked (cost ${cost} XP).`;
        showToast(`Level ${nextLvl} unlocked!`, 'success');
        checkAndAwardBadges();
        spawnConfetti();
      } else {
        msg += ` ✅ Passed! Earn more XP to unlock Level ${nextLvl} (needs ${cost} XP).`;
        showToast(`Passed! Collect more XP to unlock Level ${nextLvl}.`, 'info');
      }
    } else {
      // final level bonus
      const reward = 120;
      state.xp += reward;
      msg += ` 🏆 Final level cleared — +${reward} XP bonus!`;
      showToast('Final level cleared — great job!', 'success');
      spawnConfetti();
      checkAndAwardBadges();
    }

    saveState();
    updateProgress();

    const prog = $('#brx-test-progress'); if (prog) prog.innerText = msg;

    // after pass, close test and refresh levels
    setTimeout(()=> { closeTest(); renderLevels(); }, 900);
  }

  // ---------- manual unlock ----------
  function requestUnlock(level){
    const expected = state.unlockedLevels + 1;
    if (level !== expected) { showToast('You can only unlock the next level in sequence.', 'warn'); return; }
    const cost = unlockCostFor(level);
    if (state.xp < cost) { showToast(`Not enough XP — need ${cost} XP to unlock Level ${level}.`, 'warn'); return; }
    state.xp -= cost;
    state.unlockedLevels = Math.max(state.unlockedLevels, level);
    saveState();
    showToast(`Unlocked Level ${level}!`, 'success');
    checkAndAwardBadges();
    renderLevels();
    spawnConfetti();
    updateProgress();
  }

  // ---------- badges ----------
  function checkAndAwardBadges(){
    const newly = [];
    BADGES.forEach(b => {
      if (state.unlockedLevels >= b.level && !(Array.isArray(state.badgesEarned) && state.badgesEarned.includes(b.code))) {
        state.badgesEarned.push(b.code);
        newly.push(b.code);
      }
    });
    if (newly.length){
      saveState();
      renderBadgeStrip();
      newly.forEach(code => animateBadgeEarn(code));
    }
  }
  function animateBadgeEarn(code){
    const el = document.querySelector(`#brx-badge-strip .brx-medal-${code}`);
    if (el){ el.classList.add('just-earned'); setTimeout(()=> el.classList.remove('just-earned'), 1600); }
    showToast(`Badge ${code} earned! ${badgeEmoji(code)}`, 'success');
    spawnConfetti();
  }
  function badgeEmoji(code){ const b = BADGES.find(x=>x.code===code); return b?b.emoji:'⭐'; }

  // ---------- confetti & toasts ----------
  function spawnConfetti(){
    const wrapper = document.createElement('div'); wrapper.className = 'brx-confetti-wrap';
    const count = 18;
    for (let i=0;i<count;i++){
      const c = document.createElement('div'); c.className = 'brx-confetti';
      c.style.left = (5 + Math.random()*90) + '%';
      c.style.background = ['#ffce00','#f59e0b','#34d399','#3b82f6','#a855f7'][Math.floor(Math.random()*5)];
      c.style.transform = `rotate(${Math.random()*360}deg)`;
      wrapper.appendChild(c);
    }
    document.body.appendChild(wrapper);
    setTimeout(()=> wrapper.classList.add('explode'), 20);
    setTimeout(()=> wrapper.remove(), 2200);
  }
  function showToast(msg, type='info'){
    let container = $('#brx-toast-container');
    if (!container){ container = document.createElement('div'); container.id='brx-toast-container'; document.body.appendChild(container); }
    const t = document.createElement('div'); t.className = `brx-toast ${type}`;
    t.innerHTML = `<div class="brx-toast-msg">${msg}</div><button class="brx-toast-close" aria-label="Close">✕</button>`;
    container.appendChild(t);
    t.querySelector('.brx-toast-close').addEventListener('click', ()=> t.remove());
    setTimeout(()=> t.classList.add('visible'), 20);
    setTimeout(()=> t.classList.remove('visible'), 3600);
    setTimeout(()=> t.remove(), 4200);
  }

  // ---------- render badge strip ----------
  function renderBadgeStrip(){
    const strip = $('#brx-badge-strip'); if (!strip) return;
    strip.innerHTML = '';
    BADGES.forEach(b=>{
      const earned = (Array.isArray(state.badgesEarned) && state.badgesEarned.includes(b.code));
      const item = document.createElement('div'); item.className = 'brx-badge-strip-item'; item.setAttribute('data-badge', b.code);
      if (earned){
        item.innerHTML = `<div class="brx-medal brx-medal-${b.code}" data-code="${b.code}"><div class="medal-core"><div class="medal-code">${b.code}</div><div class="medal-emoji">${b.emoji}</div></div><div class="brx-badge-meta"><strong>${b.name}</strong><small>${b.subtitle}</small></div></div>`;
      } else {
        item.innerHTML = `<div class="brx-medal-locked" data-code="${b.code}"><div class="medal-core"><div class="lock">🔒</div></div><div class="brx-badge-meta"><strong>${b.name}</strong><small>${b.subtitle}</small></div></div>`;
      }
      strip.appendChild(item);
    });
  }

  // ---------- levels renderer ----------
  
  function renderLevels(){
    const container = $('#brx-levels-grid'); if (!container) return;
    container.innerHTML = '';
    for (let i = 1; i <= 30; i++){
      const unlocked = i <= state.unlockedLevels;
      const isNext = i === (state.unlockedLevels + 1);
      const best = state.levelsBest[i] || 0;
      const card = document.createElement('div');
      card.className = 'brx-level-card' + (unlocked ? ' unlocked' : '') + (isNext && !unlocked ? ' next' : '');
      card.setAttribute('data-level', String(i)); card.tabIndex = 0;
      const header = document.createElement('div'); header.className = 'brx-level-header';
      header.innerHTML = `<div class="brx-level-num">Level ${i}</div>`;
      const badgeMeta = BADGES.find(b => b.level === i);
      if (badgeMeta && Array.isArray(state.badgesEarned) && state.badgesEarned.includes(badgeMeta.code)){
        const smallBadge = document.createElement('div'); smallBadge.className = `brx-level-small-badge brx-badge-${badgeMeta.code}`;
        smallBadge.innerHTML = `<div class="brx-mini-badge" data-rank="${badgeMeta.code}" title="${badgeMeta.name}"><div class="mini-medal"><span class="mini-emoji">${badgeMeta.emoji}</span></div></div>`;
        header.appendChild(smallBadge);
      }
      const body = document.createElement('div'); body.className = 'brx-level-body';
      if (unlocked){
        body.innerHTML = `<div class="brx-level-desc">Best: ${best}%</div><div class="brx-level-actions"><button class="brx-btn brx-btn-primary" onclick="brxEnglish.openTest(${i})">Open Test</button></div>`;
      } else if (isNext){
        const cost = unlockCostFor(i);
        const disabledAttr = state.xp < cost ? 'disabled' : '';
        body.innerHTML = `<div class="brx-level-desc locked-desc">— Cost: ${cost} XP</div><div class="brx-level-actions"><button class="brx-btn brx-btn-primary" onclick="brxEnglish.requestUnlock(${i})" ${disabledAttr}>Unlock</button></div>`;
      } else {
        body.innerHTML = `<div class="brx-level-desc locked-desc">Locked</div><div class="brx-level-actions"><button class="brx-btn" disabled>Locked</button></div>`;
      }
      card.appendChild(header); card.appendChild(body); container.appendChild(card);
    }
    // update xp UI and progress
    const xpValEl = $('#brx-xp-value'); if (xpValEl) xpValEl.textContent = String(state.xp);
    const xpEl = $('#brx-xp-display'); if (xpEl) xpEl.innerText = `XP: ${state.xp}`;
    const nextLevel = state.unlockedLevels + 1;
    const nextCostEl = $('#brx-next-cost') || $('#brx-xp-next');
    if (nextCostEl){
      nextCostEl.innerText = nextLevel <= 30 ? `Next: ${unlockCostFor(nextLevel)} XP` : 'All levels unlocked 🎉';
    }
    renderBadgeStrip(); updateProgress(); updateOrientation();
  }


  // ---------- progress / orientation ----------
  
  function updateProgress(){
    const bar = $('#brx-progress-bar');
    const textEl = $('#brx-progress-text');
    const xpVal = $('#brx-xp-value');
    const xpNext = $('#brx-xp-next');
    if (xpVal) xpVal.textContent = String(state.xp);
    const nextLvl = Math.min(30, state.unlockedLevels + 1);
    const nextCost = nextLvl <= 30 ? unlockCostFor(nextLvl) : 0;
    if (xpNext) xpNext.textContent = nextLvl <= 30 ? String(Math.max(0, nextCost - state.xp)) : '0';
    if (bar) bar.style.width = (nextCost ? Math.min(100, Math.round((state.xp / nextCost) * 100)) : 100) + '%';
    if (textEl) textEl.textContent = nextLvl <= 30 ? `${Math.max(0, nextCost - state.xp)} XP to next level` : 'All levels unlocked 🎉';
  }

  function updateOrientation(){ const grid = $('#brx-levels-grid'); if (!grid) return; if (window.innerWidth <= 860){ grid.classList.add('brx-vertical'); grid.setAttribute('aria-orientation','vertical'); } else { grid.classList.remove('brx-vertical'); grid.setAttribute('aria-orientation','horizontal'); } }


  // ---------- modal helpers (exposed for HTML onclicks) ----------
  function hideUnlock(){
    const m = document.getElementById('brx-unlock-modal');
    if(m) { m.classList.add('hidden'); m.setAttribute('aria-hidden','true'); m.removeAttribute('data-level'); }
  }
  function confirmUnlock(){
    // confirm using modal dataset-level if present, else unlock next
    const m = document.getElementById('brx-unlock-modal');
    const lvl = m && m.dataset && m.dataset.level ? Number(m.dataset.level) : (state.unlockedLevels + 1);
    try{ requestUnlock(lvl); }catch(e){ console.warn('confirmUnlock error', e); }
    hideUnlock();
  }
  function hideBadge(){
    const m = document.getElementById('brx-badge-modal');
    if(m) { m.classList.add('hidden'); m.setAttribute('aria-hidden','true'); }
  }
  function closeLevels(){
    try{ showScreen('menu'); }catch(e){ /* fallback: hide panel */ const lv = document.getElementById('brx-english-levels'); if(lv) lv.classList.add('hidden'); }
  }
  // ---------- init ----------
  loadState(); checkAndAwardBadges();
  setTimeout(()=>{ renderLevels(); updateProgress(); }, 80);
  window.addEventListener('resize', updateOrientation);
  updateOrientation();

  // public API
  
  // public API (exposed)
  const api = {
    loadState,
    saveState,
    renderLevels,
    submitTest,
    openTest: (lvl) => openTest(lvl),
    requestUnlock: (lvl) => requestUnlock(lvl),
    closeTest,
    confirmUnlock,
    hideUnlock,
    hideBadge,
    closeLevels
  };
  if (typeof window !== 'undefined') window.brxEnglish = api;
  return api;
if (typeof window !== 'undefined') window.brxEnglish = api;
  return api;
})();

/* ========== ABC (interactive learning) ========== */
(function(){
  // ================= DATA =================
  const ABC = [
    ["A","Apple","🍎"],["B","Ball","⚽"],["C","Cat","🐱"],["D","Dog","🐶"],["E","Elephant","🐘"],
    ["F","Fish","🐟"],["G","Grapes","🍇"],["H","Hat","🎩"],["I","Ice cream","🍦"],["J","Juice","🧃"],
    ["K","Kite","🪁"],["L","Lion","🦁"],["M","Monkey","🐵"],["N","Nest","🐣"],["O","Orange","🍊"],
    ["P","Pencil","✏️"],["Q","Queen","👸"],["R","Rabbit","🐰"],["S","Sun","☀️"],["T","Tree","🌳"],
    ["U","Umbrella","🌂"],["V","Violin","🎻"],["W","Watch","⌚"],["X","Xylophone","🎼"],["Y","Yacht","🛥️"],["Z","Zebra","🦓"],
  ];

  // ================= DOM =================
  const abcGrid       = $('#abcGrid');
  const abcLetterLarge= $('#abcLetterLarge');
  const abcImageLarge = $('#abcImageLarge');
  const abcWordLarge  = $('#abcWordLarge');
  const abcAutoPlay   = $('#abcAutoPlay');
  const abcQuizBtn    = $('#abcQuizBtn');
  const abcVoiceToggle= $('#abcVoiceToggle');

  // quiz screen elements (must exist in DOM)
  const quizScreen    = $('#childABCQuiz');
  const quizStartBtn  = quizScreen?.querySelector('#quizStartBtn');
  const quizBackBtn   = quizScreen?.querySelector('#quizBackBtn');
  const quizIntro     = quizScreen?.querySelector('#quizIntro');
  const quizArea      = quizScreen?.querySelector('#quizArea');
  const quizQuestion  = quizScreen?.querySelector('#quizQuestion');
  const quizOptions   = quizScreen?.querySelector('#quizOptions');
  const quizIndexEl   = quizScreen?.querySelector('#quizIndex');
  const quizTotalEl   = quizScreen?.querySelector('#quizTotal');
  const quizNextBtn   = quizScreen?.querySelector('#quizNextBtn');
  const quizQuitBtn   = quizScreen?.querySelector('#quizQuitBtn');
  const quizResult    = quizScreen?.querySelector('#quizResult');
  const quizScoreEl   = quizScreen?.querySelector('#quizScore');
  const quizSummary   = quizScreen?.querySelector('#quizSummary');
  const quizRetryBtn  = quizScreen?.querySelector('#quizRetryBtn');
  const quizReturnBtn = quizScreen?.querySelector('#quizReturnBtn');
  const quizLengthSelect = quizScreen?.querySelector('#quizLength');
  const quizModeSelect   = quizScreen?.querySelector('#quizMode');
  const quizFeedback     = quizScreen?.querySelector('#quizFeedback');

  // defensive no-op if missing
  const esc = window.escapeHtml || (s=> String(s));

  // ================= STATE =================
  let autoPlayTimer = null;
  let autoPlayIndex = 0;

  // quiz runtime state
  const quizState = {
    questions: [], // {type,prompt,answer,label,options}
    current: 0,
    score: 0,
    total: 10,
    mode: 'mixed'
  };

  // ================= HELPERS =================
  function fisherYatesShuffle(arr){
    const a = arr.slice();
    for(let i = a.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pickOtherLetters(n, exclude){
    const letters = ABC.map(a=>a[0]).filter(x=>x!==exclude);
    return fisherYatesShuffle(letters).slice(0,n);
  }
  function pickOtherWords(n, excludeWord){
    const words = ABC.map(a=>a[1]).filter(x=>x!==excludeWord);
    return fisherYatesShuffle(words).slice(0,n);
  }

  function playLetterTone(idx){
    // gentle musical mapping across letters
    const base = 440;
    const semitone = (idx % 12) - 9;
    const freq = Math.round(base * Math.pow(2, semitone/12));
    if(typeof window.playSfx === 'function'){
      window.playSfx([{f: freq, d:0.08}, {f: Math.round(freq*1.45), d:0.06, delay:0.08}]);
    }
  }

  // ================= RENDER GRID =================
  function renderGrid(){
    if(!abcGrid) return;
    abcGrid.innerHTML = ABC.map((item, idx) => {
      const [L, word, emo] = item;
      // tabindex for keyboard nav
      return `
        <button class="abc-card" data-idx="${idx}" aria-label="${esc(L)} for ${esc(word)}" tabindex="0">
          <div class="abc-letter">${esc(L)}</div>
          <div class="abc-emoji" aria-hidden="true">${esc(emo)}</div>
          <div class="abc-word">${esc(word)}</div>
        </button>
      `;
    }).join('');
    // bind delegates
    abcGrid.querySelectorAll('.abc-card').forEach(card=>{
      card.addEventListener('click', ()=> onSelectLetter(Number(card.dataset.idx)));
      card.addEventListener('keydown', (e)=>{ if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectLetter(Number(card.dataset.idx)); }});
    });
  }
// ================= PREVIEW =================
/**
 * onSelectLetter(idx, speakNow = false)
 * - idx: index in ABC array
 * - speakNow: boolean (default false) — only speak when true (keeps screen-open silent)
 *
 * Behavior:
 * - updates the large preview area
 * - plays the letter tone
 * - only speaks if speakNow === true (and prevents rapid duplicate speaks)
 */
let __abc_lastSpoken = { idx: null, ts: 0 };

function onSelectLetter(idx, speakNow = false){
  if(idx < 0 || idx >= ABC.length) return;
  const [L, word, emo] = ABC[idx];

  // update preview UI (keep exactly your preformat)
  if(abcLetterLarge) abcLetterLarge.textContent = L;
  if(abcImageLarge) abcImageLarge.textContent = emo || '';
  if(abcWordLarge) abcWordLarge.textContent = `${L} for ${word}`;

  // tone feedback
  playLetterTone(idx);

  // tts <- ONLY when explicitly requested (speakNow === true)
  try{
    if(speakNow && abcVoiceToggle?.checked){
      const now = Date.now();
      // Prevent rapid duplicate speak calls for the same index (debounce ~300ms)
      if(!(__abc_lastSpoken.idx === idx && (now - __abc_lastSpoken.ts) < 300)){
        __abc_lastSpoken.idx = idx;
        __abc_lastSpoken.ts = now;
        stopSpeaking();
        speak(`${L} for ${word}`, { interrupt:true, rate: 0.95 });
      }
    }
  }catch(e){ /* fail silently */ }

  // visual feedback on the tile
  try{
    const tile = abcGrid?.querySelector(`[data-idx="${idx}"]`);
    if(tile){
      tile.classList.add('selected');
      setTimeout(()=> tile.classList.remove('selected'), 320);
    }
  }catch(e){}
}


// --- helper: render grid (only call this if you want JS to create the tiles) ---
// It will create tiles and bind event handlers that request speaking explicitly.
function renderABCGrid(){
  if(!abcGrid) return;
  // avoid re-rendering if grid already has content
  if(abcGrid.children && abcGrid.children.length > 0) return;

  abcGrid.innerHTML = '';

  ABC.forEach((item, i) => {
    const [L, word, emo] = item;
    const tile = document.createElement('button');
    tile.className = 'abc-card';
    tile.setAttribute('data-idx', i);
    tile.setAttribute('type', 'button');
    tile.setAttribute('aria-label', `${L} for ${word}`);
    tile.innerHTML = `<div class="abc-letter">${L}</div><div class="abc-emoji">${emo||''}</div><div class="abc-word tiny muted">${word}</div>`;

    // click should show preview and SPEAK (speakNow = true)
    tile.addEventListener('click', (ev) => {
      ev.preventDefault();
      onSelectLetter(i, true);
    }, { passive:false });

    // keyboard (Enter / Space) for accessibility — also speaks
    tile.addEventListener('keydown', (ev) => {
      if(ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar'){
        ev.preventDefault();
        onSelectLetter(i, true);
      }
    });

    abcGrid.appendChild(tile);
  });
}


// --- robust delegation for existing/static tiles ---
// If your HTML already contains tiles or other code binds clicks without speakNow,
// this delegation ensures any click on a tile will explicitly request speaking.
(function bindABCDelegation(){
  try{
    if(!abcGrid) return;
    if(abcGrid.__brx_delegationBound) return;
    abcGrid.addEventListener('click', (ev) => {
      const tile = ev.target.closest && ev.target.closest('[data-idx]');
      if(!tile || !abcGrid.contains(tile)) return;
      const idx = Number(tile.getAttribute('data-idx'));
      if(Number.isNaN(idx)) return;
      onSelectLetter(idx, true);
    }, { passive:true });

    abcGrid.addEventListener('keydown', (ev) => {
      if(ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar'){
        const tile = ev.target.closest && ev.target.closest('[data-idx]');
        if(!tile || !abcGrid.contains(tile)) return;
        const idx = Number(tile.getAttribute('data-idx'));
        if(Number.isNaN(idx)) return;
        ev.preventDefault();
        onSelectLetter(idx, true);
      }
    }, { passive:false });

    abcGrid.__brx_delegationBound = true;
  }catch(e){}
})();

/* ================= AUTOPLAY ================= */
function startAutoPlay(intervalMs = 1400){
  stopAutoPlay();
  autoPlayIndex = 0;
  if(abcAutoPlay) { abcAutoPlay.textContent = '⏹ Stop'; abcAutoPlay.setAttribute('aria-pressed','true'); }

  // Speak explicitly from autoplay
  autoPlayTimer = setInterval(()=>{
    onSelectLetter(autoPlayIndex % ABC.length, true); // <--- speakNow = true for autoplay
    autoPlayIndex++;
    if(autoPlayIndex >= ABC.length) {
      // stop after one full cycle
      stopAutoPlay();
    }
  }, intervalMs);
}

function stopAutoPlay(){
  if(autoPlayTimer) { clearInterval(autoPlayTimer); autoPlayTimer = null; }
  if(abcAutoPlay) { abcAutoPlay.textContent = '▶ Auto Play'; abcAutoPlay.setAttribute('aria-pressed','false'); }
}

// expose stopAutoPlay so showScreen can call it
window.ABCapp = window.ABCapp || {};
window.ABCapp.stopAutoPlay = stopAutoPlay;

// button toggle (keeps same behavior)
abcAutoPlay?.addEventListener('click', ()=>{
  if(autoPlayTimer) stopAutoPlay(); else startAutoPlay(1400);
});

  // ================= QUIZ — generator & flow =================
  function generateQuestions(n, mode){
    // mode: 'image->letter' | 'letter->word' | 'mixed'
    const pool = ABC.map((a, idx) => ({ idx, L: a[0], W: a[1], E: a[2] }));
    const chosen = fisherYatesShuffle(pool).slice(0, Math.min(n, pool.length));
    const qs = chosen.map(entry => {
      const qType = (mode === 'mixed') ? (Math.random() < 0.5 ? 'image->letter' : 'letter->word') : mode;
      if(qType === 'image->letter'){
        const options = fisherYatesShuffle([entry.L, ...pickOtherLetters(3, entry.L)]);
        return { type: qType, prompt: entry.E, answer: entry.L, label: entry.W, options };
      } else {
        const options = fisherYatesShuffle([entry.W, ...pickOtherWords(3, entry.W)]);
        return { type: qType, prompt: entry.L, answer: entry.W, label: entry.E, options };
      }
    });
    return qs;
  }

  function startQuizScreen(){
    // stop autoplay
    stopAutoPlay();
    // navigate to quiz screen
    if(typeof window.showScreen === 'function') window.showScreen('childABCQuiz');
    // ensure quiz intro visible
    if(quizIntro) quizIntro.style.display = '';
    if(quizArea) quizArea.style.display = 'none';
    if(quizResult) quizResult.style.display = 'none';
    if(quizFeedback) quizFeedback.textContent = '';
  }

  function startQuiz(){
    const total = Number(quizLengthSelect?.value || 10);
    const mode  = String(quizModeSelect?.value || 'mixed');
    const qs = generateQuestions(total, mode);
    quizState.questions = qs;
    quizState.current = 0;
    quizState.score = 0;
    quizState.total = total;
    quizState.mode = mode;

    // UI
    if(quizIntro) quizIntro.style.display = 'none';
    if(quizArea) quizArea.style.display = '';
    if(quizResult) quizResult.style.display = 'none';
    renderQuestion();
  }

  function renderQuestion(){
    const q = quizState.questions[quizState.current];
    if(!q) return endQuiz();
    if(quizIndexEl) quizIndexEl.textContent = String(quizState.current + 1);
    if(quizTotalEl) quizTotalEl.textContent = String(quizState.total);

    // prompt
    if(quizQuestion){
      if(q.type === 'image->letter'){
        quizQuestion.innerHTML = `<div style="font-size:64px">${esc(q.prompt || '')}</div><div class="tiny muted" style="margin-top:8px">${esc(q.label || '')}</div>`;
        if(abcVoiceToggle?.checked) try{ speak(`Which letter is this?`, { interrupt:true }); }catch(e){}
      } else {
        quizQuestion.innerHTML = `<div style="font-size:72px;font-weight:900">${esc(q.prompt || '')}</div><div class="tiny muted" style="margin-top:8px">Which word matches this letter?</div>`;
        if(abcVoiceToggle?.checked) try{ speak(`Which word matches ${q.prompt}?`, { interrupt:true }); }catch(e){}
      }
    }

    // options
    if(quizOptions){
      quizOptions.innerHTML = '';
      quizOptions.style.gridTemplateColumns = 'repeat(2, 1fr)';
      q.options.forEach(opt=>{
        const b = document.createElement('button');
        b.className = 'btn btn-ghost';
        b.textContent = opt;
        b.dataset.choice = opt;
        b.type = 'button';
        b.addEventListener('click', ()=> handleAnswer(b, q));
        quizOptions.appendChild(b);
      });
    }

    if(quizNextBtn) quizNextBtn.disabled = true;
    if(quizFeedback) quizFeedback.textContent = '';
  }

  function handleAnswer(buttonEl, q){
    // prevent double click
    if(!buttonEl || buttonEl.disabled) return;
    // disable all options
    [...quizOptions.querySelectorAll('button')].forEach(b=>b.disabled = true);

    const choice = String(buttonEl.dataset.choice);
    const correct = choice === String(q.answer);
    if(correct){
      quizState.score++;
      buttonEl.style.border = '2px solid #14b37d';
      playSfx('correct');
      if(abcVoiceToggle?.checked) try{ speak('Correct', { interrupt:true }); }catch(e){}
      if(quizFeedback) quizFeedback.textContent = 'Correct ✓';
    } else {
      buttonEl.style.border = '2px solid #ff4d4f';
      // highlight correct
      const correctBtn = [...quizOptions.querySelectorAll('button')].find(b => String(b.dataset.choice) === String(q.answer));
      if(correctBtn) correctBtn.style.border = '2px solid #14b37d';
      playSfx('wrong');
      if(abcVoiceToggle?.checked) try{ speak('Incorrect', { interrupt:true }); }catch(e){}
      if(quizFeedback) quizFeedback.textContent = 'Incorrect — correct highlighted';
    }

    // enable Next
    if(quizNextBtn) quizNextBtn.disabled = false;
  }

  function nextQuestion(){
    quizState.current++;
    if(quizState.current >= quizState.total) return endQuiz();
    renderQuestion();
  }

  function endQuiz(){
    if(quizArea) quizArea.style.display = 'none';
    if(quizResult) quizResult.style.display = '';
    const percent = Math.round((quizState.score / quizState.total) * 100);
    if(quizScoreEl) quizScoreEl.textContent = `${quizState.score} / ${quizState.total} (${percent}%)`;
    if(quizSummary) quizSummary.textContent = `You answered ${quizState.score} out of ${quizState.total} correctly.`;
    playSfx('cheer');
    if(abcVoiceToggle?.checked) try{ speak(`Quiz finished. You scored ${quizState.score} out of ${quizState.total}`, { interrupt:true }); }catch(e){}
  }

  // ================= UI WIRES =================
  abcGrid && renderGrid();
  if(ABC.length) onSelectLetter(0, false);

  // quiz navigation binding on ABC screen: open quiz screen (not inline)
  abcQuizBtn?.addEventListener('click', startQuizScreen);

  // quiz screen controls
  quizStartBtn?.addEventListener('click', startQuiz);
  quizBackBtn?.addEventListener('click', ()=> { if(typeof window.showScreen === 'function') window.showScreen('childABC'); });
  quizNextBtn?.addEventListener('click', nextQuestion);
  quizQuitBtn?.addEventListener('click', ()=> { if(confirm('Quit quiz?')) { if(typeof window.showScreen === 'function') window.showScreen('childABC'); } });
  quizRetryBtn?.addEventListener('click', ()=> startQuiz());
  quizReturnBtn?.addEventListener('click', ()=> { if(typeof window.showScreen === 'function') window.showScreen('childABC'); });

  // support toolbar back button inside quiz (data-action="back-to-abc")
  document.addEventListener('click', (ev)=>{
    const b = ev.target.closest && ev.target.closest('[data-action="back-to-abc"]');
    if(b){ if(typeof window.showScreen === 'function') window.showScreen('childABC'); }
  });

  // keyboard support in quiz: 1-4 → option, N → next
  window.addEventListener('keydown', (ev)=>{
    if(quizArea && quizArea.style.display !== 'none'){
      const k = ev.key;
      if(/^[1-4]$/.test(k)){
        const idx = parseInt(k,10) - 1;
        const opts = [...quizOptions.querySelectorAll('button')];
        if(opts[idx]) opts[idx].click();
      }
      if(k === 'n' || k === 'N') {
        if(quizNextBtn && !quizNextBtn.disabled) quizNextBtn.click();
      }
    }
  });

  // ensure autoplay stops if we leave childABC screen (defensive)
  if(typeof window.showScreen === 'function'){
    const orig = window.showScreen;
    window.showScreen = function(id){
      orig(id);
      if(id !== 'childABC') stopAutoPlay();
      if(id === 'childABC') { /* restore preview */ onSelectLetter(0,false); }
    };
  }

  // expose for debug/control
  window.ABCapp = window.ABCapp || {};
  window.ABCapp.stopAutoPlay = stopAutoPlay;
  window.ABCapp.startAutoPlay = startAutoPlay;
  window.ABCapp.startQuizScreen = startQuizScreen;

/* ============================================================
   CHILD MATH — FULL UPGRADE (classes 6,7,8,9) — deep-thought
   - 100 questions per class (6..9) covering textbook chapter topics
   - Each quiz run picks 10 unique randomized questions (no repeats)
   - Integrates with existing UI elements: #mathClass, #startDailyMath, #mathQuiz
   - Uses deterministic pool generation (seeded) and runtime random subset pick
   ============================================================ */

/* ------------------ UI: class selector & start button ------------------ */
const childClasses = ["LKG","UKG","NC",1,2,3,4,5,6,7,8,9];
const mathSel = $('#mathClass');
if(mathSel){
  mathSel.innerHTML = '';
  childClasses.forEach(c=>{
    const opt = document.createElement('option');
    opt.value = String(c);
    opt.textContent = (Number.isFinite(Number(c)) ? `Class ${c}` : String(c));
    mathSel.appendChild(opt);
  });
  $('#startDailyMath')?.addEventListener('click', ()=>{
    playSfx('click');
    const cls = String(mathSel.value||"LKG");
    startDailyMathQuiz(cls);
  });
}

/* ------------------ Helpers & RNG ------------------ */
function fisherYatesShuffle(arr, rng=Math.random){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(rng() * (i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function seedRng(seed){
  // deterministic seeded PRNG for stable pools
  let t = typeof seed === 'number' ? seed >>> 0 : (String(seed).split('').reduce((s,ch)=> (s*31 + ch.charCodeAt(0))>>>0, 2166136261) >>> 0);
  return function(){
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + 0x6D2B79F5) >>> 0;
    let r = (t ^ (t >>> 14)) >>> 0;
    return r / 4294967296;
  };
}
function rndInt(rng, min, max){ return Math.floor(rng() * (max - min + 1)) + min; }
function gcd(a,b){ a = Math.abs(a); b = Math.abs(b); while(b){ const t=a%b; a=b; b=t; } return a; }
function lcm(a,b){ if(a===0||b===0) return 0; return Math.abs(a*b)/gcd(a,b); }
function formatNumber(n, decimals=0){
  if(decimals <= 0) return String(Math.round(Number(n)));
  return parseFloat(Number(n).toFixed(decimals)).toString();
}
function formatFraction(numer, denom){
  if(denom === 1) return String(numer);
  const sign = Math.sign(numer);
  numer = Math.abs(numer);
  const g = gcd(numer, denom);
  numer = numer/g; denom = denom/g;
  if(numer >= denom){
    const whole = Math.floor(numer/denom);
    const rem = numer % denom;
    if(rem === 0) return (sign<0?'-':'') + String(whole);
    return (sign<0?'-':'') + `${whole} ${rem}/${denom}`;
  }
  return (sign<0?'-':'') + `${numer}/${denom}`;
}
function fracToNumber(numer, denom){ return numer/denom; }

/* generate numeric distractors around correct */
function uniqueChoicesFromNumber(rng, correct, count=4, opts={ decimals:0, allowNegative:false }){
  const dec = opts.decimals || 0;
  const base = Number(correct);
  const mag = Math.max(1, Math.round(Math.abs(base) * 0.15));
  const set = new Set([ formatNumber(base, dec) ]);
  let tries = 0;
  while(set.size < count && tries < 300){
    tries++;
    // generate offset biased by magnitude
    let offset = Math.round((rng()*2 - 1) * (mag + Math.floor(rng()*mag)));
    if(rng() < 0.1) offset = Math.round(offset * (1 + Math.floor(rng()*3)));
    let cand = base + offset;
    if(!opts.allowNegative && cand < 0) cand = Math.abs(cand);
    set.add(formatNumber(cand, dec));
  }
  const arr = fisherYatesShuffle([...set], rng).slice(0, count);
  if(!arr.includes(formatNumber(base, dec))){
    arr[Math.floor(rng()*arr.length)] = formatNumber(base, dec);
  }
  return fisherYatesShuffle(arr, rng);
}

/* ------------------ Generators (many textbook chapter types) ------------------ */

/* Basic add/sub */
function gen_add_sub(rng, maxA){
  if(rng() < 0.5){
    const a = rndInt(rng, 0, maxA);
    const b = rndInt(rng, 0, maxA);
    const ans = a + b;
    return { q: `${a} + ${b}`, payload: ans, choices: uniqueChoicesFromNumber(rng, ans, 4), correctAnswer: String(ans) };
  } else {
    let a = rndInt(rng, 0, maxA);
    let b = rndInt(rng, 0, maxA);
    if(b > a) [a,b] = [b,a];
    const ans = a - b;
    return { q: `${a} - ${b}`, payload: ans, choices: uniqueChoicesFromNumber(rng, ans, 4), correctAnswer: String(ans) };
  }
}

/* multiplication & exact division */
function gen_mul_div(rng, params){
  if(rng() < 0.6){
    const a = rndInt(rng, 2, params.mulMaxA || 12);
    const b = rndInt(rng, 2, params.mulMaxB || 12);
    const ans = a * b;
    return { q: `${a} × ${b}`, payload: ans, choices: uniqueChoicesFromNumber(rng, ans, 4), correctAnswer: String(ans) };
  } else {
    const b = rndInt(rng, 2, Math.max(6, params.mulMaxB||12));
    const mul = rndInt(rng, 2, Math.max(6, params.mulMaxA||12));
    const a = b * mul;
    const ans = mul;
    return { q: `${a} ÷ ${b}`, payload: ans, choices: uniqueChoicesFromNumber(rng, ans, 4), correctAnswer: String(ans) };
  }
}

/* fractions add/sub/mul/div */
function gen_fraction_ops(rng){
  const d1 = rndInt(rng, 2, 12);
  const d2 = rndInt(rng, 2, 12);
  const n1 = rndInt(rng, 1, d1-1);
  const n2 = rndInt(rng, 1, d2-1);
  const typ = rng();
  if(typ < 0.4){
    // add
    const lcd = lcm(d1,d2);
    const nn1 = n1 * (lcd/d1);
    const nn2 = n2 * (lcd/d2);
    const sum = nn1 + nn2;
    const ans = formatFraction(sum, lcd);
    const ansNum = fracToNumber(sum,lcd);
    const choices = uniqueChoicesFromNumber(rng, ansNum, 4, { decimals:2 });
    return { q: `${n1}/${d1} + ${n2}/${d2}`, payload: ansNum, choices, correctAnswer: String(formatNumber(ansNum,2)) };
  } else if(typ < 0.8){
    // subtraction
    const lcd = lcm(d1,d2);
    const nn1 = n1 * (lcd/d1);
    const nn2 = n2 * (lcd/d2);
    const diff = Math.abs(nn1 - nn2);
    const ansNum = fracToNumber(diff, lcd);
    const choices = uniqueChoicesFromNumber(rng, ansNum, 4, { decimals:2 });
    return { q: `${Math.max(n1,n2)}/${Math.max(d1,d2)} - ${Math.min(n1,n2)}/${Math.max(d1,d2)}`, payload: ansNum, choices, correctAnswer: String(formatNumber(ansNum,2)) };
  } else {
    // multiply
    const a = rndInt(rng, 1, 9);
    const b = rndInt(rng, 1, 9);
    const ans = a * b;
    return { q: `${a}/${d1} × ${b}/${d2}`, payload: (a/d1)*(b/d2), choices: uniqueChoicesFromNumber(rng, (a/d1)*(b/d2), 4, { decimals:2 }), correctAnswer: formatNumber((a/d1)*(b/d2),2) };
  }
}

/* decimals */
function gen_decimal_ops(rng, maxA){
  const a = Number((rng()*(maxA)).toFixed(1));
  const b = Number((rng()*(maxA)).toFixed(1));
  if(rng() < 0.5){
    const ans = Number((a+b).toFixed(1));
    return { q: `${a} + ${b}`, payload: ans, choices: uniqueChoicesFromNumber(rng, ans, 4, { decimals:1 }), correctAnswer: formatNumber(ans,1) };
  } else {
    const ans = Number((Math.abs(a-b)).toFixed(1));
    return { q: `${Math.max(a,b)} - ${Math.min(a,b)}`, payload: ans, choices: uniqueChoicesFromNumber(rng, ans, 4, { decimals:1 }), correctAnswer: formatNumber(ans,1) };
  }
}

/* percentages & word percent */
function gen_percent(rng, params){
  const whole = rndInt(rng, Math.max(10, Math.floor(params.addMax/4)), Math.max(20, params.addMax));
  const pctPool = [5,10,12,15,20,25,30];
  const pct = pctPool[Math.floor(rng()*pctPool.length)];
  const ans = Number(((whole * pct) / 100).toFixed((pct%5===0)?0:1));
  return { q: `${pct}% of ${whole}`, payload: ans, choices: uniqueChoicesFromNumber(rng, ans, 4, { decimals: (pct%5===0)?0:1 }), correctAnswer: formatNumber(ans, (pct%5===0)?0:1) };
}

/* ratio & proportion */
function gen_ratio(rng){
  const a = rndInt(rng, 1, 8);
  const b = rndInt(rng, 1, 12);
  const unit = rndInt(rng, 1, 10);
  const q = `If ${a}:${b} = ${unit}:x, what is x?`;
  const correct = (b * unit) / a;
  return { q, payload: correct, choices: uniqueChoicesFromNumber(rng, correct, 4, { decimals:0 }), correctAnswer: String(Math.round(correct)) };
}

/* algebra: linear eqn single variable */
function gen_linear_eqn_one_var(rng, params){
  const a = rndInt(rng, 1, Math.max(2, Math.min(12, params.mulMaxA || 12)));
  const x = rndInt(rng, -10, Math.max(5, Math.floor(params.addMax/10)));
  const b = rndInt(rng, -5, Math.max(5, Math.floor(params.addMax/6)));
  const c = a * x + b;
  const q = `If ${a}x + ${b} = ${c}, what is x?`;
  return { q, payload: x, choices: uniqueChoicesFromNumber(rng, x, 4, { decimals:0, allowNegative: true }), correctAnswer: String(x) };
}

/* algebra: linear eqn two vars (slope/intercept) */
function gen_line_slope_midpoint(rng){
  const x1 = rndInt(rng, -10, 10);
  const y1 = rndInt(rng, -10, 10);
  const x2 = rndInt(rng, -10, 10);
  const y2 = rndInt(rng, -10, 10);
  if(x1 === x2){ // vertical line fallback: ask midpoint
    const mx = (x1 + x2)/2;
    const my = (y1 + y2)/2;
    return { q: `Midpoint of (${x1},${y1}) and (${x2},${y2})`, payload: `${mx},${my}`, choices: [`${mx},${my}`, `${mx+1},${my}`, `${mx},${my+1}`, `${mx-1},${my-1}`], correctAnswer: `${mx},${my}` };
  }
  const slope = Number(((y2 - y1) / (x2 - x1)).toFixed(2));
  return { q: `Slope of line through (${x1},${y1}) and (${x2},${y2})`, payload: slope, choices: uniqueChoicesFromNumber(rng, slope, 4, { decimals:2, allowNegative:true }), correctAnswer: formatNumber(slope,2) };
}

/* polynomials and factorization (simple) */
function gen_polynomial_factor(rng){
  const r1 = rndInt(rng, -6, 6);
  const r2 = rndInt(rng, -6, 6);
  // avoid zero roots both same to keep variety
  const a = 1;
  const b = -(r1 + r2);
  const c = r1 * r2;
  const q = `Factorize: x² ${b>=0?'+':''}${b}x ${c>=0?'+':''}${c}`;
  const choice1 = `(x ${r1<0?'+':''}${-r1})(x ${r2<0?'+':''}${-r2})`;
  const choice2 = `(x ${r1<0?'+':''}${-r1})(x ${r2<0?'+':''}${-r2+1})`;
  const choice3 = `(x ${r1<0?'+':''}${-r1+1})(x ${r2<0?'+':''}${-r2})`;
  const choices = fisherYatesShuffle([choice1, choice2, choice3, `(x ${r1<0?'+':''}${-r1-1})(x ${r2<0?'+':''}${-r2-1})`], rng);
  return { q, choices, correctAnswer: choice1 };
}

/* coordinate geometry: distance & midpoint */
function gen_coord_distance_midpoint(rng){
  const x1 = rndInt(rng, -10, 10), y1 = rndInt(rng, -10, 10);
  const x2 = rndInt(rng, -10, 10), y2 = rndInt(rng, -10, 10);
  const mx = (x1 + x2)/2, my = (y1 + y2)/2;
  const dist = Number(Math.hypot(x2 - x1, y2 - y1).toFixed(2));
  if(rng() < 0.5){
    return { q: `Midpoint of (${x1},${y1}) and (${x2},${y2})`, choices: fisherYatesShuffle([`${mx},${my}`, `${mx+1},${my}`, `${mx},${my+1}`, `${mx-1},${my-1}`], rng), correctAnswer: `${mx},${my}` };
  }
  return { q: `Distance between (${x1},${y1}) and (${x2},${y2})`, choices: uniqueChoicesFromNumber(rng, dist, 4, { decimals:2 }), correctAnswer: formatNumber(dist,2) };
}

/* geometry angles & triangle properties */
function gen_triangle_angles(rng){
  const a = rndInt(rng, 20, 100);
  const b = rndInt(rng, 10, 160 - a); // ensure sum less than 180
  const c = 180 - a - b;
  return { q: `If two angles of a triangle are ${a}° and ${b}°, what is the third angle?`, payload: c, choices: uniqueChoicesFromNumber(rng, c, 4), correctAnswer: String(c) };
}

/* pythagoras */
function gen_pythagoras(rng){
  const triples = [[3,4,5],[5,12,13],[8,15,17],[7,24,25],[9,40,41]];
  const t = triples[Math.floor(rng() * triples.length)];
  const a = t[0], b = t[1], c = t[2];
  if(rng() < 0.5){
    return { q: `A right triangle has legs ${a} and ${b}. What is the hypotenuse?`, choices: uniqueChoicesFromNumber(rng, c, 4), correctAnswer: String(c) };
  } else {
    return { q: `A right triangle has hypotenuse ${c} and one leg ${a}. What is the other leg?`, choices: uniqueChoicesFromNumber(rng, b, 4), correctAnswer: String(b) };
  }
}

/* geometry: circle area/circumference */
function gen_circle(rng){
  const r = rndInt(rng, 2, 14);
  const area = Number((Math.PI * r * r).toFixed(2));
  const circ = Number((2 * Math.PI * r).toFixed(2));
  if(rng() < 0.5){
    return { q: `Circle radius ${r} cm. Area (use π ≈ 3.1416)`, choices: uniqueChoicesFromNumber(rng, area, 4, { decimals:2 }), correctAnswer: formatNumber(area,2) };
  } else {
    return { q: `Circle radius ${r} cm. Circumference (use π ≈ 3.1416)`, choices: uniqueChoicesFromNumber(rng, circ, 4, { decimals:2 }), correctAnswer: formatNumber(circ,2) };
  }
}

/* mensuration: area & volume */
function gen_mensuration(rng){
  const typ = rng();
  if(typ < 0.4){
    const w = rndInt(rng, 2, 40), h = rndInt(rng, 2, 40);
    return { q: `Area of rectangle: width ${w} cm and height ${h} cm. Area (cm²)?`, choices: uniqueChoicesFromNumber(rng, w*h, 4), correctAnswer: String(w*h) };
  } else if(typ < 0.7){
    const l = rndInt(rng, 2, 20), b = rndInt(rng, 2, 20), h = rndInt(rng, 1, 10);
    return { q: `Volume of cuboid: ${l}×${b}×${h} (cm³)?`, choices: uniqueChoicesFromNumber(rng, l*b*h, 4), correctAnswer: String(l*b*h) };
  } else {
    const r = rndInt(rng, 1, 10), h = rndInt(rng, 1, 10);
    const vol = Number((Math.PI * r * r * h).toFixed(2));
    return { q: `Volume of cylinder: radius ${r} cm and height ${h} cm. (use π≈3.1416)`, choices: uniqueChoicesFromNumber(rng, vol, 4, { decimals:2 }), correctAnswer: formatNumber(vol,2) };
  }
}

/* statistics & probability */
function gen_stats_prob(rng){
  const typ = rng();
  if(typ < 0.5){
    const n = rndInt(rng, 3, 7);
    const arr = Array.from({length:n}, ()=> rndInt(rng, 1, 20));
    const mean = arr.reduce((s,v)=>s+v,0)/n;
    return { q: `Find the mean of ${arr.join(', ')}`, choices: uniqueChoicesFromNumber(rng, mean, 4, { decimals:1 }), correctAnswer: formatNumber(mean,1) };
  } else {
    const total = rndInt(rng, 2, 12), success = rndInt(rng, 1, total-1);
    const prob = Number((success/total).toFixed(2));
    return { q: `If ${success} out of ${total} outcomes are success, what's the probability?`, choices: uniqueChoicesFromNumber(rng, prob, 4, { decimals:2 }), correctAnswer: formatNumber(prob,2) };
  }
}

/* time-speed-distance & simple rate problems (suitable for 7-9) */
function gen_speed_time_dist(rng){
  const dist = rndInt(rng, 10, 200);
  const speed = rndInt(rng, 5, 80);
  const time = Number((dist / speed).toFixed(2));
  return { q: `If a vehicle travels ${dist} km at ${speed} km/h, how long (hours)?`, choices: uniqueChoicesFromNumber(rng, time, 4, { decimals:2 }), correctAnswer: formatNumber(time,2) };
}

/* LCM/GCD */
function gen_lcm_gcd(rng){
  const a = rndInt(rng, 2, 30), b = rndInt(rng, 2, 30);
  if(rng() < 0.5) return { q: `GCD of ${a} and ${b}`, choices: uniqueChoicesFromNumber(rng, gcd(a,b), 4), correctAnswer: String(gcd(a,b)) };
  return { q: `LCM of ${a} and ${b}`, choices: uniqueChoicesFromNumber(rng, lcm(a,b), 4), correctAnswer: String(lcm(a,b)) };
}

/* polynomial basics / factorization already defined as gen_polynomial_factor earlier, reuse it */
function gen_polynomial_factor_wrapper(rng){ return gen_polynomial_factor(rng); }

/* ------------------ Pool builder tuned to class chapters ------------------ */
function makeMathPool(classKey){
  const pool = [];
  const clsNum = Number(classKey) || 0;
  const isPre = ["LKG","UKG","NC"].includes(classKey);
  const seedBase = 202700 + (isPre ? 11 : (clsNum || 0) * 199);
  const rng = seedRng(seedBase);

  // params by class to control magnitude
  const params = {};
  if(isPre){ params.addMax = 10; params.mulMaxA = 6; params.mulMaxB = 6; }
  else if(clsNum <= 2){ params.addMax = 20; params.mulMaxA = 8; params.mulMaxB = 8; }
  else if(clsNum === 3){ params.addMax = 60; params.mulMaxA = 10; params.mulMaxB = 10; }
  else if(clsNum === 4 || clsNum === 5){ params.addMax = 200; params.mulMaxA = 12; params.mulMaxB = 12; }
  else if(clsNum === 6){ params.addMax = 500; params.mulMaxA = 20; params.mulMaxB = 12; params.allowDecimals = true; }
  else if(clsNum === 7){ params.addMax = 700; params.mulMaxA = 30; params.mulMaxB = 15; params.allowDecimals = true; }
  else if(clsNum === 8){ params.addMax = 900; params.mulMaxA = 40; params.mulMaxB = 18; params.allowDecimals = true; params.includeAlgebra = true; }
  else { params.addMax = 1500; params.mulMaxA = 60; params.mulMaxB = 25; params.allowDecimals = true; params.includeAlgebra = true; }

  // generator weights by class (cover textbook chapters)
  // We'll assemble a weighted array of generator functions and randomly pick from it.
  const gens = [];
  if(isPre){
    gens.push(()=> gen_add_sub(rng, params.addMax));
    gens.push(()=> gen_fraction_ops(rng));
  } else if(clsNum <= 2){
    gens.push(()=> gen_add_sub(rng, params.addMax));
    gens.push(()=> gen_mul_div(rng, params));
    gens.push(()=> gen_fraction_ops(rng));
    gens.push(()=> gen_lcm_gcd(rng));
  } else if(clsNum === 3){
    gens.push(()=> gen_add_sub(rng, params.addMax));
    gens.push(()=> gen_mul_div(rng, params));
    gens.push(()=> gen_fraction_ops(rng));
    gens.push(()=> gen_lcm_gcd(rng));
    gens.push(()=> gen_coord_distance_midpoint(rng));
  } else if(clsNum <= 5){
    gens.push(()=> gen_add_sub(rng, params.addMax));
    gens.push(()=> gen_mul_div(rng, params));
    gens.push(()=> gen_fraction_ops(rng));
    gens.push(()=> gen_geometry_area(rng));
    gens.push(()=> gen_lcm_gcd(rng));
    gens.push(()=> gen_coord_distance_midpoint(rng));
  } else if(clsNum === 6){
    gens.push(()=> gen_algebra_linear(rng, params));
    gens.push(()=> gen_fraction_ops(rng));
    gens.push(()=> gen_mul_div(rng, params));
    gens.push(()=> gen_geometry_area(rng));
    gens.push(()=> gen_pythagoras(rng));
    gens.push(()=> gen_stats_prob(rng));
    gens.push(()=> gen_lcm_gcd(rng));
    gens.push(()=> gen_percent(rng, params));
  } else if(clsNum === 7){
    gens.push(()=> gen_algebra_linear(rng, params));
    gens.push(()=> gen_fraction_ops(rng));
    gens.push(()=> gen_mul_div(rng, params));
    gens.push(()=> gen_geometry_area(rng));
    gens.push(()=> gen_pythagoras(rng));
    gens.push(()=> gen_stats_prob(rng));
    gens.push(()=> gen_coord_distance_midpoint(rng));
    gens.push(()=> gen_lcm_gcd(rng));
    gens.push(()=> gen_percent(rng, params));
    gens.push(()=> gen_ratio(rng));
  } else if(clsNum === 8){
    gens.push(()=> gen_algebra_linear(rng, params));
    gens.push(()=> gen_polynomial_factor_wrapper(rng));
    gens.push(()=> gen_fraction_ops(rng));
    gens.push(()=> gen_mul_div(rng, params));
    gens.push(()=> gen_geometry_area(rng));
    gens.push(()=> gen_pythagoras(rng));
    gens.push(()=> gen_coord_distance_midpoint(rng));
    gens.push(()=> gen_stats_prob(rng));
    gens.push(()=> gen_percent(rng, params));
    gens.push(()=> gen_mensuration(rng));
  } else { // 9
    gens.push(()=> gen_algebra_linear(rng, params));
    gens.push(()=> gen_polynomial_factor_wrapper(rng));
    gens.push(()=> gen_fraction_ops(rng));
    gens.push(()=> gen_mul_div(rng, params));
    gens.push(()=> gen_geometry_area(rng));
    gens.push(()=> gen_pythagoras(rng));
    gens.push(()=> gen_coord_distance_midpoint(rng));
    gens.push(()=> gen_stats_prob(rng));
    gens.push(()=> gen_percent(rng, params));
    gens.push(()=> gen_mensuration(rng));
    gens.push(()=> gen_speed_time_dist(rng));
    gens.push(()=> gen_lcm_gcd(rng));
  }

  // Build pool with dedupe by question text
  const qSet = new Set();
  let attempts = 0, maxAttempts = 2500;
  while(pool.length < 100 && attempts < maxAttempts){
    attempts++;
    const g = gens[Math.floor(rng() * gens.length)];
    let item;
    try { item = g(); } catch(e){ continue; }
    if(!item || !item.q) continue;
    const qText = String(item.q).trim();
    if(qSet.has(qText)) continue;
    qSet.add(qText);

    // normalize choices + correctAnswer
    let choices = (item.choices || item.Choices || []).map(c => String(c));
    if(!Array.isArray(choices) || choices.length < 4){
      if(typeof item.payload === 'number'){
        choices = uniqueChoicesFromNumber(rng, item.payload, 4, { decimals: (String(item.payload).indexOf('.')!==-1)?2:0 });
      } else if(typeof item.correctAnswer === 'string' && item.correctAnswer.match(/[,]/)){
        // special case for midpoint "x,y"
        choices = [ item.correctAnswer, '0,0', '-1,1', '1,-1'];
      } else {
        // fallback: replicate correctAnswer with small variations
        const ca = String(item.correctAnswer || item.payload || '').slice(0,10);
        choices = [ca, ca+'1', ca+'2', ca+'3'];
      }
    }
    // ensure choices length 4
    choices = choices.slice(0,4);
    choices = fisherYatesShuffle(choices, rng);

    const correctAnswer = String(item.correctAnswer || item.payload || choices[0]);

    pool.push({ q: qText, choices, correctAnswer: String(correctAnswer) });
  }

  // If not enough generated, pad with simple additions to reach 100
  while(pool.length < 100){
    const a = Math.floor(rng()*500);
    const b = Math.floor(rng()*500);
    const ans = a + b;
    const choices = uniqueChoicesFromNumber(rng, ans, 4);
    pool.push({ q: `${a} + ${b}`, choices, correctAnswer: String(ans) });
  }

  return pool.slice(0,100);
}

/* ------------------ pick randomized subset of size N (no repeats in set) ------------------ */
function pickRandomSubset(pool, count = 10){
  const indices = Array.from(pool.keys());
  const shuffled = fisherYatesShuffle(indices, Math.random);
  const pick = shuffled.slice(0, Math.min(count, pool.length));
  return pick.map(i => pool[i]);
}

/* ------------------ start daily quiz (random 10 unique questions per run) ------------------ */
function startDailyMathQuiz(classKey){
  const pool = makeMathPool(classKey);
  const subset = pickRandomSubset(pool, 10);
  console.log(`Math quiz for ${classKey}: pool=${pool.length}. Selected ${subset.length} Qs.`);
  // renderQuiz expects element and array of Q objects {q, choices, correctAnswer}
  renderQuiz($('#mathQuiz'), subset, { announce: true });
}

/* ======================= END CHILD MATH ======================= */

/* close the main IIFE so script runs safely */
})(); // end main app IIFE

/* ========== ENGLISH QUIZ (deep — 30 Qs per class, 100-item pool via cycling) ========= */
const eqSel = $('#engQuizClass');
if(eqSel){
  ["LKG","UKG","NC","1","2","3","4","5","6","7","8","9","10"].forEach(c=>{
    const opt = document.createElement('option');
    opt.value = String(c);
    opt.textContent = (["LKG","UKG","NC"].includes(c) ? c : `Class ${c}`);
    eqSel.appendChild(opt);
  });
  $('#startDailyEnglish')?.addEventListener('click', ()=>{
    playSfx('click');
    const cls = String(eqSel.value||"1");
    const pool = makeEnglishPool(cls);
    const idxs = pickDailyIndexes(100,10,"eng_"+cls);
    const subset = idxs.map(i=>pool[i]);
    renderQuiz($('#englishQuizBox'), subset, {announce:true});
  });
}

function makeEnglishPool(cls){
  // ----------- normalize class key -----------
  function normalizeKey(k){
    if(!k) return "1";
    const s = String(k).trim();
    const low = s.toLowerCase();
    if(low === "lkg") return "lkg";
    if(low === "ukg") return "ukg";
    if(low === "nc")  return "nc";
    const num = parseInt(s,10);
    if(!isNaN(num) && num >=1 && num <= 10) return String(num);
    const m = s.match(/\d+/);
    if(m){
      const nn = parseInt(m[0],10);
      if(!isNaN(nn) && nn>=1 && nn<=10) return String(nn);
    }
    return "1";
  }
  const key = normalizeKey(cls);

  // small helpers
  const pick = arr => arr[Math.floor(Math.random()*arr.length)];
  function shuffle(arr){
    const a = arr.slice();
    for(let i=a.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const extraWords = ["book","song","movie","game","poem","story","lesson","puzzle","table","city","river","market","school","garden",
                      "apple","orange","banana","friend","teacher","mountain","window","leaf","leaflet","note","letter"];

  // ----------- question banks (kept exactly but integrated here) -----------
  const banks = {
    "lkg": [
      {q:"Which word starts with 'A'?", opts:["Apple","Ball","Cat","Dog"], a:0},
      {q:"Which animal says 'meow'?", opts:["Dog","Cat","Cow","Sheep"], a:1},
      {q:"Which is a fruit?", opts:["Chair","Apple","Table","Pen"], a:1},
      {q:"Which is round?", opts:["Ball","Box","Pencil","Bag"], a:0},
      {q:"What do we drink?", opts:["Water","Sand","Stone","Paper"], a:0},
      {q:"Which do you sleep on?", opts:["Bed","Spoon","Clock","Chair"], a:0},
      {q:"Which is used to write?", opts:["Pencil","Shoe","Plate","Glass"], a:0},
      {q:"Which colour is the sky?", opts:["Blue","Black","Green","Pink"], a:0},
      {q:"Which animal has stripes?", opts:["Tiger","Sheep","Cow","Goat"], a:0},
      {q:"Which is a baby cat called?", opts:["Kitten","Calf","Foal","Puppy"], a:0},
      {q:"Which has wheels?", opts:["Car","Tree","Book","Shoe"], a:0},
      {q:"Which is sweet to eat?", opts:["Apple","Stone","Paper","Shoe"], a:0},
      {q:"Which one can fly?", opts:["Bird","Dog","Cow","Fish"], a:0},
      {q:"Which is used to drink milk?", opts:["Glass","Spoon","Lamp","Clock"], a:0},
      {q:"Which one is a vegetable?", opts:["Carrot","Ball","Shoe","Table"], a:0},
      {q:"Which one is hot to touch?", opts:["Fire","Water","Ice","Leaf"], a:0},
      {q:"Which one is a farm animal?", opts:["Cow","Cat","Fish","Bird"], a:0},
      {q:"Which is used for cutting paper?", opts:["Scissors","Spoon","Fork","Glass"], a:0},
      {q:"Which is used on the head?", opts:["Hat","Shoe","Chair","Table"], a:0},
      {q:"Which is used by a teacher?", opts:["Book","Car","Spoon","Shoe"], a:0},
      {q:"Which is a toy to cuddle?", opts:["Teddy","Fork","Ruler","Plate"], a:0},
      {q:"Which has many pages?", opts:["Book","Shoe","Lamp","Bed"], a:0},
      {q:"Which animal says 'moo'?", opts:["Cow","Cat","Dog","Bird"], a:0},
      {q:"Which is used to cut fruit?", opts:["Knife","Spoon","Plate","Cup"], a:0},
      {q:"Which is used to comb hair?", opts:["Comb","Pen","Pencil","Ruler"], a:0},
      {q:"Which one gives us eggs?", opts:["Hen","Cow","Dog","Cat"], a:0},
      {q:"Which one is yellow and sour?", opts:["Lemon","Apple","Tomato","Potato"], a:0},
      {q:"Which one is used to tell time?", opts:["Clock","Chair","Table","Shoe"], a:0},
      {q:"Which one grows on trees?", opts:["Leaves","Car","Book","Shoe"], a:0}
    ],

    "ukg": [
      {q:"Which animal barks?", opts:["Cat","Dog","Cow","Hen"], a:1},
      {q:"Pick the colour of grass.", opts:["Green","Blue","Red","Yellow"], a:0},
      {q:"What do bees make?", opts:["Honey","Milk","Bread","Water"], a:0},
      {q:"Which one flies?", opts:["Bird","Cow","Dog","Fish"], a:0},
      {q:"Which is a vehicle?", opts:["Car","Table","Tree","Pen"], a:0},
      {q:"Which rhymes with 'cat'?", opts:["Bat","Pen","Book","Tree"], a:0},
      {q:"Which season is hot?", opts:["Summer","Winter","Rainy","Spring"], a:0},
      {q:"How many legs does a spider have?", opts:["Eight","Four","Two","Six"], a:0},
      {q:"Which is used to drink?", opts:["Cup","Shoe","Plate","Book"], a:0},
      {q:"Which animal swims?", opts:["Fish","Cow","Dog","Bird"], a:0},
      {q:"Pick the opposite of 'big'", opts:["Small","Huge","Tall","Long"], a:0},
      {q:"Which do we wear on feet?", opts:["Shoes","Hat","Ring","Cap"], a:0},
      {q:"Which one is used to cut?", opts:["Scissors","Clock","Book","Lamp"], a:0},
      {q:"Which is a tasty fruit?", opts:["Mango","Shoe","Chair","Car"], a:0},
      {q:"Which animal gives us milk?", opts:["Cow","Cat","Dog","Duck"], a:0},
      {q:"Which one is used to call someone?", opts:["Phone","Table","Tree","Spoon"], a:0},
      {q:"Which one is a toy?", opts:["Doll","Book","Shoe","Plate"], a:0},
      {q:"Which is used to write on paper?", opts:["Pencil","Spoon","Shoe","Bag"], a:0},
      {q:"Which one is a night animal?", opts:["Owl","Horse","Cow","Fish"], a:0},
      {q:"Which one is used in rain?", opts:["Umbrella","Sunglasses","Fan","Boot"], a:0},
      {q:"Which is round and used in games?", opts:["Ball","Plate","Chair","Book"], a:0},
      {q:"Which animal has hooves?", opts:["Cow","Dog","Cat","Bird"], a:0},
      {q:"Which do we put food in?", opts:["Plate","Book","Shoe","Spoon"], a:0},
      {q:"Which animal is very big and gray?", opts:["Elephant","Dog","Cat","Rabbit"], a:0},
      {q:"Which one is used to drink milk?", opts:["Glass","Bag","Shoe","Spoon"], a:0},
      {q:"Which rides on tracks?", opts:["Train","Car","Plane","Boat"], a:0},
      {q:"Which is used to draw pictures?", opts:["Crayon","Fork","Knife","Spoon"], a:0},
      {q:"Which is used to keep things cold?", opts:["Fridge","Fan","Oven","Lamp"], a:0}
    ],

    "nc": [
      {q:"Which gives us milk?", opts:["Cow","Cat","Lion","Snake"], a:0},
      {q:"Which is used to cut paper?", opts:["Scissors","Spoon","Shoe","Bag"], a:0},
      {q:"Which one flies?", opts:["Bird","Fish","Cow","Dog"], a:0},
      {q:"Which is sweet to eat?", opts:["Candy","Rock","Leaf","Stick"], a:0},
      {q:"Which grows on trees?", opts:["Leaves","Cars","Beds","Shoes"], a:0},
      {q:"Which animal has a mane?", opts:["Lion","Dog","Cow","Sheep"], a:0},
      {q:"Which is used to drink water?", opts:["Glass","Bowl","Shoe","Table"], a:0},
      {q:"Which is a food we eat with rice?", opts:["Curry","Pencil","Book","Spoon"], a:0},
      {q:"Which is a domestic animal?", opts:["Dog","Tiger","Lion","Deer"], a:0},
      {q:"Which is used for climbing?", opts:["Ladder","Spoon","Plate","Book"], a:0},
      {q:"Which lives in water?", opts:["Fish","Cow","Bird","Dog"], a:0},
      {q:"Which is a sweet fruit?", opts:["Mango","Stone","Leaf","Clock"], a:0},
      {q:"Which do we wear on hands?", opts:["Gloves","Shoes","Shirt","Hat"], a:0},
      {q:"Which is used to carry things?", opts:["Bag","Spoon","Lamp","Clock"], a:0},
      {q:"Which animal says 'moo'?", opts:["Cow","Dog","Cat","Bird"], a:0},
      {q:"Which has feathers?", opts:["Bird","Cat","Cow","Dog"], a:0},
      {q:"Which helps you see at night?", opts:["Lamp","Bed","Shoe","Table"], a:0},
      {q:"Which is green and grows in fields?", opts:["Grass","Stone","Shoe","Car"], a:0},
      {q:"Which is a baby dog called?", opts:["Puppy","Foal","Calf","Kid"], a:0},
      {q:"Which is used for eating soup?", opts:["Spoon","Knife","Fork","Ruler"], a:0},
      {q:"Which one is a farm tool?", opts:["Plough","Phone","Book","Shoe"], a:0},
      {q:"Which is a small house for birds?", opts:["Nest","Car","Bed","Chair"], a:0},
      {q:"Which is used to sweep the floor?", opts:["Broom","Pen","Knife","Spoon"], a:0},
      {q:"Which animal hops and has long legs?", opts:["Kangaroo","Dog","Cow","Cat"], a:0},
      {q:"Which is used to boil water?", opts:["Kettle","Shoe","Plate","Book"], a:0},
      {q:"Which vegetable is green and long?", opts:["Cucumber","Potato","Tomato","Onion"], a:0},
      {q:"Which gives us wool?", opts:["Sheep","Cow","Dog","Cat"], a:0},
      {q:"Which is used to cut vegetables?", opts:["Knife","Fork","Spoon","Ruler"], a:0},
      {q:"Which animal has a trunk?", opts:["Elephant","Horse","Cow","Goat"], a:0}
    ],

    "1": [
      {q:"Choose correct: ___ apple.", opts:["An","A","The","No article"], a:0},
      {q:"Plural of 'cat' is ___", opts:["cats","cat","cates","catz"], a:0},
      {q:"He ___ a boy.", opts:["is","are","am","be"], a:0},
      {q:"Opposite of 'big' is ___", opts:["small","huge","tall","long"], a:0},
      {q:"Fill: I ___ apples.", opts:["have","has","had","having"], a:0},
      {q:"Choose pronoun: ___ am happy.", opts:["I","He","She","They"], a:0},
      {q:"Which is a vegetable?", opts:["Potato","Apple","Bread","Water"], a:0},
      {q:"Which used to write on board?", opts:["Chalk","Book","Bag","Shoe"], a:0},
      {q:"Which season has snow?", opts:["Winter","Summer","Rainy","Spring"], a:0},
      {q:"Which lives in water?", opts:["Fish","Dog","Cat","Cow"], a:0},
      {q:"Opposite of hot is ___", opts:["cold","warm","hotter","boiling"], a:0},
      {q:"Day after Monday is ___", opts:["Tuesday","Sunday","Saturday","Friday"], a:0},
      {q:"Used to cut paper: ___", opts:["Scissors","Pen","Spoon","Ruler"], a:0},
      {q:"Shape with three sides is ___", opts:["Triangle","Square","Circle","Rectangle"], a:0},
      {q:"Helps to see far: ___", opts:["Binoculars","Phone","Book","Shoe"], a:0},
      {q:"Yellow fruit: ___", opts:["Banana","Apple","Grapes","Orange"], a:0},
      {q:"Animal gives wool: ___", opts:["Sheep","Cow","Dog","Cat"], a:0},
      {q:"Drink tea from a ___", opts:["Cup","Spoon","Fork","Knife"], a:0},
      {q:"Keep time with a ___", opts:["Clock","Bag","Chair","Table"], a:0},
      {q:"Sit on a ___", opts:["Chair","Bed","Book","Spoon"], a:0},
      {q:"Summer is ___ than winter (comparative)", opts:["hotter","hot","hottest","cold"], a:0},
      {q:"Which one is used to draw?", opts:["Pencil","Plate","Spoon","Fork"], a:0},
      {q:"Opposite of up is ___", opts:["down","high","top","above"], a:0},
      {q:"Which one is used to clean teeth?", opts:["Toothbrush","Spoon","Comb","Plate"], a:0},
      {q:"Which is used to cut vegetables?", opts:["Knife","Fork","Spoon","Ruler"], a:0},
      {q:"Which animal has a long neck?", opts:["Giraffe","Cow","Cat","Dog"], a:0},
      {q:"Which one is a pet?", opts:["Dog","Lion","Tiger","Elephant"], a:0},
      {q:"Which is used to open a bottle?", opts:["Opener","Spoon","Pen","Ruler"], a:0},
      {q:"Which one is a sweet?", opts:["Candy","Salt","Toothpaste","Soap"], a:0}
    ],

    "2": [
      {q:"She ___ to school every day.", opts:["goes","go","gone","going"], a:0},
      {q:"Plural of 'box' is ___", opts:["boxes","boxs","box","boxen"], a:0},
      {q:"Opposite of 'fast' is ___", opts:["slow","quick","speedy","swift"], a:0},
      {q:"Which tells time?", opts:["Clock","Book","Bag","Shoe"], a:0},
      {q:"Choose pronoun: ___ am happy.", opts:["I","He","She","They"], a:0},
      {q:"Fill: We ___ in a big house.", opts:["live","lives","living","lived"], a:0},
      {q:"Farm produce is ___", opts:["Wheat","Car","Phone","Shoe"], a:0},
      {q:"Fill: He ___ his room every day.", opts:["cleans","clean","cleaned","is cleaning"], a:0},
      {q:"Used to cut food: ___", opts:["Knife","Spoon","Plate","Cup"], a:0},
      {q:"___ elephant", opts:["An","A","The","No article"], a:0},
      {q:"Which is a circle shape?", opts:["Circle","Heart","Triangle","Square"], a:0},
      {q:"Boats move with ___", opts:["oars","wheels","legs","engines"], a:0},
      {q:"Measure length with a ___", opts:["Ruler","Clock","Phone","Bag"], a:0},
      {q:"Grows in gardens: ___", opts:["Flowers","Cars","Phones","Shoes"], a:0},
      {q:"Green vegetable: ___", opts:["Spinach","Apple","Bread","Milk"], a:0},
      {q:"Used to mop the floor: ___", opts:["Mop","Spoon","Knife","Fork"], a:0},
      {q:"Animal that lays eggs: ___", opts:["Hen","Cow","Dog","Cat"], a:0},
      {q:"Used in rain: ___", opts:["Umbrella","Coat","Sunglasses","Fan"], a:0},
      {q:"Helps us hear: ___", opts:["Ear","Eye","Nose","Hand"], a:0},
      {q:"Heavy: stone or feather? ___", opts:["Stone","Feather","Both same","None"], a:0},
      {q:"What color is a ripe banana?", opts:["Yellow","Green","Blue","Red"], a:0},
      {q:"What do cows eat?", opts:["Grass","Meat","Fish","Chocolate"], a:0},
      {q:"What do bees build?", opts:["Hive","Nest","Hole","Den"], a:0},
      {q:"Which vehicle flies?", opts:["Plane","Ship","Car","Cycle"], a:0},
      {q:"Which one is a farm animal?", opts:["Goat","Shark","Parrot","Tiger"], a:0},
      {q:"Which helps to cut paper?", opts:["Scissors","Rock","Spoon","Shoe"], a:0},
      {q:"Which one is used to drink soup?", opts:["Spoon","Fork","Plate","Knife"], a:0},
      {q:"What do you use to carry books?", opts:["Bag","Plate","Shoe","Glass"], a:0},
      {q:"Which one is green and crunchy?", opts:["Cucumber","Cake","Ice-cream","Chocolate"], a:0}
    ],

    "3": [
      {q:"Past tense of 'go' is ___", opts:["went","goed","gone","goes"], a:0},
      {q:"Plural of 'child' is ___", opts:["children","childs","childes","child"], a:0},
      {q:"Choose article: ___ elephant", opts:["An","A","The","No article"], a:0},
      {q:"He ___ his homework yesterday.", opts:["did","do","does","done"], a:0},
      {q:"Which is a means of transport?", opts:["Bus","Pencil","Spoon","Chair"], a:0},
      {q:"Which is a profession?", opts:["Doctor","Apple","Table","Dog"], a:0},
      {q:"The sun ___ in the east.", opts:["rises","rise","rose","risen"], a:0},
      {q:"Used to write in exams: ___", opts:["Pen","Spoon","Fork","Knife"], a:0},
      {q:"Opposite of 'happy' is ___", opts:["sad","glad","cheerful","merry"], a:0},
      {q:"Which is an action word?", opts:["Run","Blue","Tall","Happy"], a:0},
      {q:"This is ___ book.", opts:["my","me","I","mine"], a:0},
      {q:"Plural of 'ox' is ___", opts:["oxen","oxs","oxes","ox"], a:0},
      {q:"Used to clean teeth: ___", opts:["Toothbrush","Comb","Spoon","Plate"], a:0},
      {q:"The cat is ___ the table.", opts:["on","in","at","by"], a:0},
      {q:"Which animal gives wool?", opts:["Sheep","Cow","Dog","Cat"], a:0},
      {q:"Which is a living thing?", opts:["Bird","Car","Chair","Book"], a:0},
      {q:"She ___ a letter now.", opts:["is writing","writes","wrote","written"], a:0},
      {q:"Punctuation to end a sentence: ___", opts:["Full stop","Comma","Colon","Semi-colon"], a:0},
      {q:"Heavier: rock or paper? ___", opts:["Rock","Paper","Both same","None"], a:0},
      {q:"He is taller ___ me.", opts:["than","then","too","also"], a:0},
      {q:"Which tells time quicker: clock or calendar?", opts:["Clock","Calendar","Book","Shoe"], a:0},
      {q:"Which is past of 'eat'?", opts:["ate","eated","eaten","eating"], a:0},
      {q:"Which is a pronoun?", opts:["She","Book","Table","Chair"], a:0},
      {q:"Which word describes colour: ___", opts:["Blue","Run","Eat","Sleep"], a:0},
      {q:"Which one is a vegetable: ___", opts:["Tomato","Dog","Cat","Bird"], a:0},
      {q:"Which preposition: 'He sat ___ the chair.'", opts:["on","in","under","beside"], a:0},
      {q:"Which is comparative of 'small'?", opts:["smaller","smallest","more small","most small"], a:0},
      {q:"Which shows possession: 'This is ___' -> (mine)", opts:["mine","my","me","I"], a:0},
      {q:"Which makes noise: ___", opts:["Drum","Book","Spoon","Glass"], a:0}
    ],

    "4": [
      {q:"She ___ to the market.", opts:["went","goes","go","gone"], a:0},
      {q:"Antonym of 'brave' is ___", opts:["coward","brave","bold","strong"], a:0},
      {q:"Collective noun for fish?", opts:["school","herd","flock","pack"], a:0},
      {q:"He lives ___ Delhi.", opts:["in","on","at","by"], a:0},
      {q:"Which is an adverb?", opts:["Quickly","Quick","Happy","Blue"], a:0},
      {q:"Plural: 'leaf' -> ___", opts:["leaves","leafs","leafes","leaf"], a:0},
      {q:"Synonym of 'happy' is ___", opts:["joyful","sad","angry","tired"], a:0},
      {q:"Which is a noun?", opts:["Table","Run","Blue","Quick"], a:0},
      {q:"Opposite of 'arrive' is ___", opts:["depart","come","reach","enter"], a:0},
      {q:"She sat ___ the chair.", opts:["on","in","at","over"], a:0},
      {q:"Form of 'to be' is ___", opts:["was","did","has","make"], a:0},
      {q:"I ___ the movie yesterday.", opts:["saw","see","seen","seeing"], a:0},
      {q:"She is ___ than him.", opts:["taller","tall","tallest","more tall"], a:0},
      {q:"Which asks a question?", opts:["Why","Yes","No","Because"], a:0},
      {q:"Which punctuation is a comma?", opts:[",",";","?","."], a:0},
      {q:"Birds ___ in the sky.", opts:["fly","flies","flew","flown"], a:0},
      {q:"Pick article: ___ hour", opts:["An","A","The","No article"], a:0},
      {q:"Which is an adjective?", opts:["Beautiful","Run","Quickly","Sing"], a:0},
      {q:"Which is a preposition?", opts:["under","run","blue","quick"], a:0},
      {q:"Which is third person singular? 'He ___' -> ___", opts:["is","are","am","be"], a:0},
      {q:"Which sentence is correct?", opts:["She has a red pen.","She have a red pen.","She had a red pen.","She were a red pen."], a:0},
      {q:"Which is the plural of 'mouse'?", opts:["mice","mouses","mouse","meese"], a:0},
      {q:"Which is opposite of 'never'?", opts:["always","seldom","rarely","sometimes"], a:0},
      {q:"Choose correct verb: 'They ___ happy.'", opts:["are","is","am","be"], a:0},
      {q:"Pick the right tense: 'I will go' -> future", opts:["future","past","present","perfect"], a:0},
      {q:"Which is a conjunction?", opts:["and","but","or","so"], a:0},
      {q:"Which shows ownership: 'her' or 'she'?", opts:["her","she","they","we"], a:0},
      {q:"Which is plural of 'tooth'?", opts:["teeth","tooths","toothe","tooths"], a:0},
      {q:"How many days in a week?", opts:["Seven","Five","Six","Eight"], a:0}
    ],

    "5": [
      {q:"He ___ already left.", opts:["has","have","had","did"], a:0},
      {q:"If I ___ a bird, I would fly.", opts:["were","was","am","is"], a:0},
      {q:"Which is a modal verb?", opts:["can","is","has","do"], a:0},
      {q:"Which indicates frequency?", opts:["often","red","tall","cold"], a:0},
      {q:"Passive: 'They made a cake.' -> 'A cake ___'", opts:["was made","is made","made","will be made"], a:0},
      {q:"Use 'fewer' for ___", opts:["countable nouns","uncountable nouns","both","none"], a:0},
      {q:"Homophone of 'flower' is ___", opts:["flour","flower","flowr","flouer"], a:0},
      {q:"Antonym of 'polite' is ___", opts:["rude","kind","gentle","nice"], a:0},
      {q:"'I had finished' -> tense is ___", opts:["past perfect","present perfect","simple past","future"], a:0},
      {q:"Conjunction in 'I wanted to go but it rained' is ___", opts:["but","and","or","so"], a:0},
      {q:"Shows ability: ___", opts:["can","must","should","shall"], a:0},
      {q:"She ___ the piano.", opts:["plays","play","played","playing"], a:0},
      {q:"Synonym of 'brave' is ___", opts:["courageous","scared","timid","shy"], a:0},
      {q:"Direct speech: He said 'I am tired' -> He said that he ___ tired.", opts:["was","is","were","are"], a:0},
      {q:"Which is an abstract noun?", opts:["happiness","chair","dog","book"], a:0},
      {q:"Tag: 'She is coming, ___?'", opts:["isn't she","is she","aren't they","don't they"], a:0},
      {q:"Plural of 'tomato' is ___", opts:["tomatoes","tomatos","tomati","tomates"], a:0},
      {q:"Compound word example: ___", opts:["notebook","note","book","table"], a:0},
      {q:"'I will have eaten' -> tense is ___", opts:["future perfect","simple future","present perfect","past perfect"], a:0},
      {q:"Which is an idiom? 'Piece of cake' means ___", opts:["very easy","very hard","expensive","dangerous"], a:0},
      {q:"Use of 'since' shows ___", opts:["starting point in time","amount","frequency","place"], a:0},
      {q:"Identify verb: 'He jumped high' -> ___", opts:["jumped","high","he","the"], a:0},
      {q:"Opposite of 'arrive' is ___", opts:["depart","reach","come","enter"], a:0},
      {q:"Which is correct plural: 'city' -> ___", opts:["cities","citys","cties","citiez"], a:0},
      {q:"Choose correct preposition: 'fond ___ music'", opts:["of","in","on","at"], a:0},
      {q:"Which is phrasal verb 'give up' means ___", opts:["stop trying","start","continue","move"], a:0},
      {q:"Which shows suggestion: 'should' or 'must' -> ___", opts:["should","must","can","will"], a:0},
      {q:"Pick the adverb in: 'She spoke softly.' -> ___", opts:["softly","she","spoke","the"], a:0},
      {q:"Which is correct: 'a little' used for ___", opts:["uncountable nouns","countable nouns","both","none"], a:0}
    ],

    "6": [
      {q:"Reported: 'I am happy' -> He said he ___ happy.", opts:["was","is","be","were"], a:0},
      {q:"Conjunction: I like tea ___ coffee.", opts:["and","but","or","so"], a:0},
      {q:"Synonym of 'quick' is ___", opts:["rapid","slow","lazy","weak"], a:0},
      {q:"Idiom 'piece of cake' means ___", opts:["very easy","very hard","boring","expensive"], a:0},
      {q:"Correct spelling is ___", opts:["accommodate","acommodate","accomodate","acomodate"], a:0},
      {q:"Antonym of 'scarce' is ___", opts:["abundant","rare","little","few"], a:0},
      {q:"Passive: 'They will finish it' -> 'It ___ by them.'", opts:["will be finished","will finished","is finished","was finished"], a:0},
      {q:"'Neither John nor his friends ___ present.' -> choose ___", opts:["are","is","was","were"], a:0},
      {q:"Collocation: '___ a promise'", opts:["keep","make","do","have"], a:0},
      {q:"Proper noun example: ___", opts:["India","city","village","lake"], a:0},
      {q:"Conditional: If he had money, he ___ buy a bike.", opts:["would","will","can","may"], a:0},
      {q:"Relative pronoun: 'The man ___ called is my uncle.'", opts:["who","which","whom","whose"], a:0},
      {q:"'Very' is a ___", opts:["adverb","adjective","noun","verb"], a:0},
      {q:"Pick correct preposition: 'fond ___ music' -> ___", opts:["of","in","on","at"], a:0},
      {q:"Phrasal verb 'put off' means ___", opts:["postpone","remove","start","finish"], a:0},
      {q:"Synonym of 'ancient' is ___", opts:["old","modern","new","recent"], a:0},
      {q:"Gerund in 'Swimming is fun' is ___", opts:["Swimming","is","fun","none"], a:0},
      {q:"Antonym of 'optimistic' is ___", opts:["pessimistic","hopeful","cheerful","positive"], a:0},
      {q:"Punctuation for list is ___", opts:["comma","period","question mark","exclamation"], a:0},
      {q:"Choose correct: 'She suggested that he ___ earlier.'", opts:["leave","left","leaves","had left"], a:0},
      {q:"'Make up' can mean ___", opts:["invent","sleep","eat","walk"], a:0},
      {q:"Which is countable: ___", opts:["apple","water","sand","milk"], a:0},
      {q:"Use 'less' with ___", opts:["uncountable nouns","countable nouns","both","none"], a:0},
      {q:"Pick the noun: 'Beautiful garden' -> ___", opts:["garden","beautiful","the","a"], a:0},
      {q:"Compound word example: ___", opts:["wheelchair","wheel","chair","room"], a:0},
      {q:"Choose correct: 'He is used ___ cold weather.'", opts:["to","with","for","at"], a:0},
      {q:"Which is a synonym of 'brave'?", opts:["courageous","afraid","shy","timid"], a:0},
      {q:"Choose correct future perfect: 'By 2025 I ___ finished.'", opts:["will have","will had","have will","had will"], a:0},
      {q:"Pick the correct passive form: 'They clean the room.' -> 'The room ___'", opts:["is cleaned","are cleaned","was cleaned","has cleaned"], a:0}
    ],

    "7": [
      {q:"Passive: 'They built the bridge' -> The bridge ___", opts:["was built","is built","built","will be built"], a:0},
      {q:"Reported speech: 'She likes apples' -> She said she ___ apples.", opts:["liked","likes","like","is liking"], a:0},
      {q:"Phrasal verb to cancel is ___", opts:["call off","put on","give in","take up"], a:0},
      {q:"Fill: He apologized ___ being late.", opts:["for","to","about","with"], a:0},
      {q:"Synonym of 'brave' is ___", opts:["courageous","scared","timid","shy"], a:0},
      {q:"Conditional: If I had time, I ___ help you.", opts:["would","will","can","could"], a:0},
      {q:"'Neither' pairs with ___", opts:["nor","or","and","but"], a:0},
      {q:"Pick article: 'It is ___ honour' -> ___", opts:["an","a","the","no article"], a:0},
      {q:"Collocation: '___ a decision' -> ___", opts:["make","do","have","take"], a:0},
      {q:"Rhetorical device: repetition at line starts is ___", opts:["anaphora","metaphor","simile","alliteration"], a:0},
      {q:"Subordinating conjunction example: ___", opts:["although","and","but","or"], a:0},
      {q:"Tense: He ___ since morning. -> choose", opts:["has been working","is working","was working","worked"], a:0},
      {q:"Plural of 'analysis' is ___", opts:["analyses","analysises","analysis","analysi"], a:0},
      {q:"Synonym of 'reluctant' is ___", opts:["hesitant","eager","keen","sure"], a:0},
      {q:"Compound-complex sentence has ___", opts:["more than one clause and at least one subordinate clause","single clause","only nouns","only verbs"], a:0},
      {q:"Part of speech of 'quickly' is ___", opts:["adverb","adjective","noun","verb"], a:0},
      {q:"Choose correct: 'I wish I ___' -> past form", opts:["had","have","has","will"], a:0},
      {q:"Linking verb example: ___", opts:["seem","run","jump","eat"], a:0},
      {q:"Antonym of 'complex' is ___", opts:["simple","difficult","hard","tough"], a:0},
      {q:"Punctuation for a question is ___", opts:["?","!",".",","], a:0},
      {q:"Relative clause starts with ___", opts:["which/that/who","and","but","or"], a:0},
      {q:"Choose: 'If only I ___' -> (wish)", opts:["had","have","will","would"], a:0},
      {q:"'To inf' after verb: 'want to ___' -> choose", opts:["go","going","goes","gone"], a:0},
      {q:"Choose correct tense: 'She had been reading' is ___", opts:["past perfect continuous","present perfect","simple past","future perfect"], a:0},
      {q:"Pick correct: 'Neither of the boys ___ here.'", opts:["is","are","were","have"], a:0},
      {q:"Choose correct: 'by the time he came, I ___' -> ___", opts:["had left","have left","left","will leave"], a:0},
      {q:"Which is rhetorical question?", opts:["a question asked for effect not answer","a math problem","a command","a statement"], a:0},
      {q:"Identify adverb in: 'He speaks softly.' -> ___", opts:["softly","he","speaks","the"], a:0},
      {q:"Choose correct collocation: '___ a speech' -> ___", opts:["deliver","make","do","have"], a:0}
    ],

    "8": [
      {q:"If it rains, we ___ inside.", opts:["will stay","stay","stayed","would stay"], a:0},
      {q:"By next year I ___ my degree.", opts:["will have completed","will complete","have completed","had completed"], a:0},
      {q:"Indirect question starter: 'Could you tell me ___' -> ___", opts:["where the station is","where is the station","where station","station where"], a:0},
      {q:"Prefix to make opposite of 'visible' is ___", opts:["in","un","re","pre"], a:0},
      {q:"Gerund: He is good at ___", opts:["swimming","swim","to swim","swam"], a:0},
      {q:"Modal showing obligation is ___", opts:["must","may","can","might"], a:0},
      {q:"Conditional II example: 'If I were rich, I ___' -> ___", opts:["would travel","will travel","travel","had travelled"], a:0},
      {q:"Correct use of 'whose' is for ___", opts:["possession","time","place","manner"], a:0},
      {q:"Synonym of 'obvious' is ___", opts:["clear","hidden","vague","doubtful"], a:0},
      {q:"Reported: 'I am leaving' -> He said he ___", opts:["was leaving","is leaving","has left","will leave"], a:0},
      {q:"Inversion: 'Hardly ___ when' -> ___", opts:["had I arrived","I had arrived","did I arrive","have I arrived"], a:0},
      {q:"Idiom: 'on cloud nine' means ___", opts:["very happy","sad","angry","tired"], a:0},
      {q:"Collocation: 'lodge a ___' -> ___", opts:["complaint","chair","book","pen"], a:0},
      {q:"'However' shows ___", opts:["contrast","sequence","addition","cause"], a:0},
      {q:"'A few' vs 'few' : 'a few' indicates ___", opts:["some (positive)","none","a lot","zero"], a:0},
      {q:"Evaluative adjective example: ___", opts:["excellent","run","blue","five"], a:0},
      {q:"Passive: 'They are building a bridge' -> 'A bridge ___' -> ___", opts:["is being built","are being built","was built","has built"], a:0},
      {q:"I prefer tea ___ coffee.", opts:["to","over","than","with"], a:0},
      {q:"She is good ___ maths.", opts:["at","in","on","for"], a:0},
      {q:"'to study' shows ___", opts:["purpose (infinitive)","place","time","manner"], a:0},
      {q:"Which is a complex sentence?", opts:["one independent + one subordinate clause","two independent only","single clause","list of nouns"], a:0},
      {q:"Choose correct: 'No sooner ___ than' -> ___", opts:["had he reached, than he left","he had reached, than he left","did he reach, than he left","he reached, then left"], a:0},
      {q:"Which is a linking word for reason?", opts:["because","and","but","or"], a:0},
      {q:"Choose the right conjunction: 'She failed ___ she didn't study.'", opts:["because","but","and","or"], a:0},
      {q:"Pick correct phrase: '___ a rest' -> ___", opts:["take","make","do","have"], a:0},
      {q:"Which is the correct use of 'despite'?", opts:["Despite the rain, we went out.","Despite raining, we went out.","Despite the rains went out.","Despite we went out."], a:0},
      {q:"Choose correct collocation: 'pay ___ attention' -> ___", opts:["pay close attention","pay tight attention","pay small attention","pay quick attention"], a:0},
      {q:"Pick synonym: 'scarce' -> ___", opts:["rare","abundant","plentiful","common"], a:0},
      {q:"Which verb form after 'after' (sequence)? 'After he ___' -> ___", opts:["had left","left","has left","will leave"], a:0}
    ],

    "9": [
      {q:"In 'The Lost Child' the child cries for ___", opts:["his parents","a toy","a sweet","a puppy"], a:0},
      {q:"Who wrote 'The Lost Child'?", opts:["Mulk Raj Anand","Ruskin Bond","O. Henry","G.L. Fuentes"], a:0},
      {q:"In 'The Adventures of Toto' Toto is a ___", opts:["monkey","parrot","dog","cat"], a:1},
      {q:"Who is the author of 'The Adventures of Toto'?", opts:["Ruskin Bond","R.K. Narayan","O. Henry","James Herriot"], a:0},
      {q:"In 'Iswaran the Storyteller', Iswaran is employed as a ___", opts:["cook","shopkeeper","teacher","doctor"], a:0},
      {q:"Which story shows faith and innocence in class 9 text?", opts:["The Lost Child","The Midnight Visitor","The Necklace","The Hack Driver"], a:0},
      {q:"In 'The Last Leaf' who is Behrman?", opts:["an old painter","a doctor","a neighbour","a child"], a:0},
      {q:"'The Last Leaf' symbolises ___", opts:["hope","fear","anger","pride"], a:0},
      {q:"Which device is 'deafening silence' an example of?", opts:["oxymoron","simile","metaphor","alliteration"], a:0},
      {q:"In 'The Adventures of Toto', who finds Toto mischievous?", opts:["the narrator's mother","the narrator's father","a stranger","the neighbour"], a:0},
      {q:"'Iswaran the Storyteller' teaches about ___", opts:["power of storytelling","mathematics","science facts","athletics"], a:0},
      {q:"Which question tests inference from a passage?", opts:["What can we infer from the character's actions?","What is the punctuation?","How many lines?","What colour is the sky?"], a:0},
      {q:"In 'The Lost Child' the fair is described as ___", opts:["loud and colourful","quiet and small","empty and boring","dark and cold"], a:0},
      {q:"The mood of 'The Last Leaf' is mainly ___", opts:["hopeful and touching","angry and violent","comic and silly","mysterious and scary"], a:0},
      {q:"Which is a theme common in Moments/Beehive stories?", opts:["human values","sportsmanship","advanced maths","computer science"], a:0},
      {q:"In 'Iswaran the Storyteller' Mahendra's job was ___", opts:["transferable every now and then","to paint","to farm","to teach"], a:0},
      {q:"Which choice shows the meaning of 'melancholy'?", opts:["sadness","joy","anger","playfulness"], a:0},
      {q:"In 'The Adventures of Toto' the family treats Toto as ___", opts:["a pet and a mischief","a wild animal","a farm animal","a stranger"], a:0},
      {q:"Which device is repetition at the start of lines called?", opts:["anaphora","metaphor","simile","hyperbole"], a:0},
      {q:"Choose the correct transformation: 'They read the book.' -> Passive: 'The book ___ by them.'", opts:["was read","is read","reads","has read"], a:0},
      {q:"Which question checks vocabulary in context?", opts:["What does 'melancholy' mean?","What is 2+2?","Name the town?","List the number of characters."], a:0},
      {q:"In 'The Lost Child' who ultimately comforts the child?", opts:["his parents","the shopkeeper","a stranger","the fair manager"], a:0},
      {q:"'Tone' of a passage means ___", opts:["author's attitude toward subject","length of passage","number of characters","story setting"], a:0},
      {q:"Which is a minor character in 'The Lost Child'?", opts:["shopkeeper","Lencho","Behrman","Tricki"], a:0},
      {q:"Which skill helps find main idea quickly?", opts:["read first & last sentences","count words","read footnotes","focus on images"], a:0},
      {q:"In 'The Last Leaf' Johnsy was ill from ___", opts:["pneumonia","cold","fever","injury"], a:0},
      {q:"Which device: 'Her face was like a pale moon' is ___", opts:["simile","metaphor","alliteration","oxymoron"], a:0},
      {q:"Who is often the narrator in 'The Adventures of Toto' stories? ", opts:["the child's grandfather or narrator","the teacher","the shopkeeper","the policeman"], a:0},
      {q:"Which is an inference skill question?", opts:["Why did the child cry?","How many pages?","What is the chapter number?","How many authors?"], a:0}
    ],

    "10": [
      {q:"In 'A Letter to God' Lencho was a ___", opts:["farmer","plumber","engineer","teacher"], a:0},
      {q:"The hailstorm in Lencho's story ruined his ___", opts:["crop","house","car","book"], a:0},
      {q:"Who received the letter from Lencho at the post office?", opts:["the postmaster","the bank manager","the teacher","the neighbour"], a:0},
      {q:"In 'A Triumph of Surgery' Tricki is a ___", opts:["dog","cat","parrot","horse"], a:0},
      {q:"Why did Mrs Pumphrey spoil Tricki?", opts:["because she doted on him","because she was busy","because she hated him","for training"], a:0},
      {q:"In 'The Thief's Story' who trusts the thief?", opts:["Anil","Lencho","Behrman","Tricki"], a:0},
      {q:"What change occurs in 'The Thief's Story' protagonist?", opts:["a softening of heart","becoming richer","becoming famous","moving abroad"], a:0},
      {q:"Which device is 'deafening silence' an example of?", opts:["oxymoron","simile","metaphor","alliteration"], a:0},
      {q:"In 'The Midnight Visitor' Ausable is a ___", opts:["clever secret agent","farmer","postman","teacher"], a:0},
      {q:"'The Necklace' centres on Mathilde's desire for ___", opts:["luxury and status","adventure","charity","knowledge"], a:0},
      {q:"Who wrote 'A Letter to God'?", opts:["G.L. Fuentes","Ruskin Bond","O. Henry","James Herriot"], a:0},
      {q:"Who wrote 'A Triumph of Surgery'?", opts:["James Herriot","Ruskin Bond","O. Henry","Mulk Raj Anand"], a:0},
      {q:"In 'The Hack Driver' the narrator is a ___", opts:["young lawyer","doctor","teacher","merchant"], a:0},
      {q:"'Footprints Without Feet' includes a story about an invisible man named ___", opts:["Griffin","Behrman","Lencho","Anil"], a:0},
      {q:"Griffin becomes ___ in 'Footprints Without Feet'", opts:["invisible","famous","rich","alive"], a:0},
      {q:"Which theme is common in many Class 10 stories?", opts:["human values and moral lessons","physics problems","advanced calculus","ancient history"], a:0},
      {q:"Which device is irony?", opts:["contrast between expectation & reality","a long simile","repetition","list"], a:0},
      {q:"Which story shows sacrifice through art?", opts:["The Last Leaf","The Thief's Story","A Letter to God","The Lost Child"], a:0},
      {q:"Who is Behrman in 'The Last Leaf'?", opts:["an old painter","a farmer","a postman","a shopkeeper"], a:0},
      {q:"Choose the correct past perfect sentence:", opts:["By the time we came, they had left.","We have left now.","We will have left.","We leave yesterday."], a:0},
      {q:"Change to passive: 'They will finish the work.' -> 'The work ___ by them.'", opts:["will be finished","is finished","was finished","has finished"], a:0},
      {q:"In 'The Necklace' Mathilde borrows a necklace from ___", opts:["her friend Mme. Forestier","her mother","her teacher","the shopkeeper"], a:0},
      {q:"The moral of many class 10 tales emphasises ___", opts:["honesty, empathy and human values","only competition","wealth accumulation","winning at all costs"], a:0},
      {q:"In 'The Midnight Visitor' Ausable outwits ___", opts:["a thief/spy (Max)","a teacher","a farmer","a doctor"], a:0},
      {q:"Which device: 'His face ashen with fear' is ___", opts:["simile","metaphor","oxymoron","alliteration"], a:0},
      {q:"In 'A Triumph of Surgery' the vet is called ___", opts:["James Herriot (narrator)","Lencho","Anil","Mr Pumphrey"], a:0},
      {q:"Which question tests inference in class 10 texts?", opts:["Why did the character act so?","How many pages?","When was the author born?","What is the chapter number?"], a:0},
      {q:"'The Thief's Story' explores the theme of ___", opts:["change through kindness","technology","war","sports"], a:0},
      {q:"Who wrote 'The Last Leaf'?", opts:["O. Henry","Ruskin Bond","Mulk Raj Anand","G.L. Fuentes"], a:0},
      {q:"Which is a good summary strategy?", opts:["Read opening & closing sentences and topic sentences","Count the words","Memorize author bio","Translate all words"], a:0}
    ]
  }; // end banks

  // ensure every bank has at least 30 items (padding if needed)
  Object.keys(banks).forEach(k=>{
    const arr = banks[k];
    while(arr.length < 30){
      arr.push({ q: "Choose the correct option.", opts: ["A","B","C","D"], a:0 });
    }
  });

  // select templates for key (fallback to "1")
  const templates = banks[key] || banks["1"];

  // Expand to pool of 100 by cycling templates and lightly randomizing placeholders
  const pool = [];
  let idx = 0;
  while(pool.length < 100){
    const base = templates[idx % templates.length];
    const safeBase = base || { q: "Choose the correct option.", opts: ["A","B","C","D"], a: 0 };

    // clone and optionally substitute small placeholders
    let qText = String(safeBase.q);
    if(qText.includes("{X}")) qText = qText.replace(/\{X\}/g, pick(extraWords));

    let opts = (safeBase.opts || []).slice().map(o=>{
      const s = String(o);
      return s.includes("{X}") ? s.replace(/\{X\}/g, pick(extraWords)) : s;
    });

    // ensure 4 options
    while(opts.length < 4) opts.push(pick(extraWords));

    // robust correct answer extraction by index (before shuffle)
    const aIndex = (typeof safeBase.a === "number" && safeBase.a >= 0 && safeBase.a < opts.length) ? safeBase.a : 0;
    const correctText = String(opts[aIndex]);

    // Shuffle the options so the correct answer does not always remain at index 0
    opts = shuffle(opts);

    // push question object in the format expected by renderQuiz: { q, choices, correctAnswer }
    pool.push({ q: qText, choices: opts, correctAnswer: String(correctText) });
    idx++;
  }

  return pool;
}


/* ========== TABLES ========= */
const tableWrap = $('#tablesWrap');
const tableSel = $('#tableSelect');
if(tableWrap && tableSel){
  for(let t=1;t<=40;t++){
    const card = document.createElement('div');
    card.className = "table-card";
    card.innerHTML = `<h4>× ${t}</h4>` + Array.from({length:10},(_,i)=>`${t} × ${i+1} = <b>${t*(i+1)}</b>`).map(x=>`<div>${x}</div>`).join("");
    tableWrap.appendChild(card);

    const opt = document.createElement('option');
    opt.value = t; opt.textContent = `Table ${t}`;
    tableSel.appendChild(opt);
  }
  $('#startTableTest')?.addEventListener('click', ()=>{
    playSfx('click');
    const t = Number(tableSel.value||2);
    const qs = [];
    for(let i=0;i<5;i++){
      const n = Math.floor(Math.random()*10)+1;
      const ans = t*n;
      const ch = shuffle([ans, ans + t, Math.max(0, ans - t), ans+1]).slice(0,4);
      qs.push({ q:`${t} × ${n} = ?`, choices: ch.map(String), correctAnswer: String(ans) });
    }
    renderQuiz($('#tableQuiz'), qs, {announce:true});
  });
}
/* ====== Science Quiz Module (append to script.js) ====== */
(function(){
  // ensure runs after DOM ready & after your core helpers exist
  document.addEventListener('DOMContentLoaded', ()=>{

    // 1) Register screens (insert before 'gk' if present)
    try {
      if(window.screens && Array.isArray(screens)){
        const insertBefore = screens.indexOf('gk');
        const newS = ['science','scienceClassSelect','scienceQuiz','scienceResults','learnScience'];
        if(insertBefore >= 0){
          screens.splice(insertBefore, 0, ...newS);
        } else {
          screens.push(...newS);
        }
      }
    } catch(e){ console.warn('[Science] screens insertion failed', e); }

    /* ====== QUESTION BANK: 20 unique MCQs per class (3..10) ======
       Each entry: { id, q, options:[], answer: <0-based index>, explain }
       Questions are exclusive per-class (no overlaps).
    */
    const scienceQuestions = {
      "3": [
        {id:'3-1', q:'Which part of a plant makes food?', options:['Root','Leaf','Flower','Stem'], answer:1, explain:'Leaves have chlorophyll and perform photosynthesis.'},
        {id:'3-2', q:'Which of these is a mammal?', options:['Frog','Eagle','Cow','Crocodile'], answer:2, explain:'Cows are mammals: have hair and produce milk.'},
        {id:'3-3', q:'Which sense do we use to see?', options:['Taste','Smell','Hearing','Sight'], answer:3, explain:'Sight uses the eyes.'},
        {id:'3-4', q:'The Sun provides us with?', options:['Sound','Light and heat','Cold','Water'], answer:1, explain:'The Sun is the main source of light and heat.'},
        {id:'3-5', q:'Which is a solid at room temperature?', options:['Water','Ice','Air','Steam'], answer:1, explain:'Ice is solid water.'},
        {id:'3-6', q:'When water is heated it becomes?', options:['Ice','Gas/Steam','Sand','Metal'], answer:1, explain:'Water vapour (steam) forms when water is heated.'},
        {id:'3-7', q:'Which helps plants to make food?', options:['Soil','Sunlight','Wind','Rocks'], answer:1, explain:'Sunlight is used during photosynthesis.'},
        {id:'3-8', q:'A baby frog is called a?', options:['Foal','Tadpole','Calf','Chick'], answer:1, explain:'A tadpole is the larval stage of a frog.'},
        {id:'3-9', q:'Which material stretches easily?', options:['Wood','Glass','Rubber','Stone'], answer:2, explain:'Rubber can stretch a lot.'},
        {id:'3-10', q:'Leaves usually fall in which season?', options:['Summer','Winter','Spring','Autumn'], answer:3, explain:'Leaves commonly fall in autumn.'},
        {id:'3-11', q:'Which gas do humans exhale?', options:['Oxygen','Carbon dioxide','Nitrogen','Helium'], answer:1, explain:'Humans breathe out carbon dioxide.'},
        {id:'3-12', q:'Which organ pumps blood?', options:['Lungs','Liver','Heart','Kidney'], answer:2, explain:'The heart pumps blood through the body.'},
        {id:'3-13', q:'What do bees make?', options:['Milk','Honey','Silk','Soap'], answer:1, explain:'Bees make honey.'},
        {id:'3-14', q:'Which animal is active at night?', options:['Sparrow','Owl','Butterfly','Cow'], answer:1, explain:'Owls are nocturnal.'},
        {id:'3-15', q:'Which tool measures temperature?', options:['Ruler','Thermometer','Scale','Clock'], answer:1, explain:'Thermometer measures temperature.'},
        {id:'3-16', q:'Earth is roughly what shape?', options:['Flat','Cube','Round','Cylinder'], answer:2, explain:'The Earth is approximately spherical (round).'},
        {id:'3-17', q:'Which force pulls objects toward Earth?', options:['Friction','Magnetism','Gravity','Electricity'], answer:2, explain:'Gravity pulls things toward Earth.'},
        {id:'3-18', q:'What is at the centre of our solar system?', options:['Moon','Earth','Sun','Mars'], answer:2, explain:'The Sun is the centre of our solar system.'},
        {id:'3-19', q:'Plants take in which gas to make food?', options:['Oxygen','Carbon dioxide','Hydrogen','Argon'], answer:1, explain:'Plants use carbon dioxide for photosynthesis.'},
        {id:'3-20', q:'Which animal lives mainly in water?', options:['Dog','Fish','Cow','Eagle'], answer:1, explain:'Fish live in water.'},
        {id:'3-21', q:'Which animal has a long trunk?', options:['Elephant','Horse','Dog','Cat'], answer:0, explain:'Elephants have trunks used for breathing, smelling and grabbing.'},
    {id:'3-22', q:'Which helps birds fly?', options:['Feathers','Fur','Scales','Teeth'], answer:0, explain:'Feathers are adapted for flight.'},
    {id:'3-23', q:'Red + Yellow makes which colour?', options:['Orange','Purple','Green','Brown'], answer:0, explain:'Mixing red and yellow paint gives orange.'},
    {id:'3-24', q:'Which helps spread seeds?', options:['Wind','Rock','Plastic','Metal'], answer:0, explain:'Wind can carry small seeds to new places.'},
    {id:'3-25', q:'Which organ do we use to smell?', options:['Nose','Ear','Eye','Hand'], answer:0, explain:'The nose detects smells.'},
    {id:'3-26', q:'Which food comes from cows?', options:['Milk','Honey','Wool','Silk'], answer:0, explain:'Cows produce milk.'},
    {id:'3-27', q:'Which of these is NOT alive?', options:['Tree','Rock','Flower','Grass'], answer:1, explain:'Rocks are non-living objects.'},
    {id:'3-28', q:'Which tool cuts paper?', options:['Scissors','Hammer','Ruler','Spoon'], answer:0, explain:'Scissors are used to cut paper.'},
    {id:'3-29', q:'Which animal is a baby cat called?', options:['Kitten','Puppy','Calf','Foal'], answer:0, explain:'A baby cat is a kitten.'},
    {id:'3-30', q:'Which helps protect plants from cold?', options:['Mulch','Salt','Plastic','Glass'], answer:0, explain:'Mulch insulates soil and protects roots.'},
    {id:'3-31', q:'Which moves when you press a switch?', options:['Light','Stone','Cloud','Shadow'], answer:0, explain:'A switch can turn a light on or off.'},
    {id:'3-32', q:'Water in river is in which state?', options:['Liquid','Solid','Gas','Plasma'], answer:0, explain:'River water is liquid.'},
    {id:'3-33', q:'Which animal has feathers and beak?', options:['Duck','Cow','Dog','Snake'], answer:0, explain:'Ducks are birds with feathers and beaks.'},
    {id:'3-34', q:'Which helps plants get water from soil?', options:['Roots','Leaves','Fruits','Flowers'], answer:0, explain:'Roots absorb water and nutrients.'},
    {id:'3-35', q:'Which is a source of food for humans?', options:['Fruits','Rocks','Metals','Plastic'], answer:0, explain:'Fruits are edible and nutritious.'},
    {id:'3-36', q:'Which keeps us warm in winter?', options:['Jacket','Fan','Umbrella','Sunglasses'], answer:0, explain:'A jacket provides warmth.'},
    {id:'3-37', q:'Which object gives light at night?', options:['Lamp','Tree','Stone','Chair'], answer:0, explain:'A lamp produces artificial light.'},
    {id:'3-38', q:'Which liquid do plants need most?', options:['Water','Oil','Juice','Soda'], answer:0, explain:'Water is essential for plant growth.'},
    {id:'3-39', q:'Which animal hops and has long legs?', options:['Kangaroo','Cow','Elephant','Fish'], answer:0, explain:'Kangaroos hop using strong hind legs.'},
    {id:'3-40', q:'Which helps you listen to music?', options:['Ear','Nose','Eye','Hand'], answer:0, explain:'Ears receive sound.'},
    {id:'3-41', q:'Which do bees collect from flowers?', options:['Nectar','Rock','Soil','Water'], answer:0, explain:'Bees collect nectar to make honey.'},
    {id:'3-42', q:'Which grows from a seed?', options:['Plant','Car','House','Book'], answer:0, explain:'Seeds germinate and form plants.'},
    {id:'3-43', q:'Which animal swims in water?', options:['Fish','Dog','Cow','Bird'], answer:0, explain:'Fish are adapted to live in water.'},
    {id:'3-44', q:'Which season is usually hot?', options:['Summer','Winter','Autumn','Spring'], answer:0, explain:'Summer is typically the hottest season.'},
    {id:'3-45', q:'Which helps you see at night?', options:['Torch','Tree','Shoe','Pen'], answer:0, explain:'A torch (flashlight) provides light in dark.'},
    {id:'3-46', q:'Which gas do plants give out at night?', options:['Oxygen','Carbon dioxide','Helium','Hydrogen'], answer:1, explain:'Plants respire and release some CO₂ at night.'},
    {id:'3-47', q:'Which animal says "meow"?', options:['Cat','Horse','Sheep','Duck'], answer:0, explain:'Cats make a "meow" sound.'},
    {id:'3-48', q:'Which object is used to write?', options:['Pencil','Plate','Spoon','Ball'], answer:0, explain:'Pencil is used for writing.'},
    {id:'3-49', q:'Which natural thing gives shade?', options:['Tree','Stone','Plastic','Paper'], answer:0, explain:'Trees provide shade with their canopy.'},
    {id:'3-50', q:'Which helps keep food fresh in fridge?', options:['Cold','Heat','Sunlight','Fire'], answer:0, explain:'Cold temperature preserves food in a fridge.'}
      ],
      "4": [
        {id:'4-1', q:'Which of these is NOT a state of matter?', options:['Solid','Liquid','Soft','Gas'], answer:2, explain:'Soft is not a state of matter.'},
        {id:'4-2', q:'What happens during condensation?', options:['Liquid → gas','Gas → liquid','Solid → liquid','Liquid → solid'], answer:1, explain:'Condensation is gas turning into liquid.'},
        {id:'4-3', q:'Which animal builds a nest and lays eggs?', options:['Cow','Sparrow','Dog','Cat'], answer:1, explain:'Sparrows build nests and lay eggs.'},
        {id:'4-4', q:'Which part of the plant absorbs water?', options:['Leaf','Stem','Root','Flower'], answer:2, explain:'Roots absorb water from soil.'},
        {id:'4-5', q:'Which is used to measure length?', options:['Thermometer','Ruler','Clock','Scale'], answer:1, explain:'A ruler measures length.'},
        {id:'4-6', q:'A habitat is the place where an animal...', options:['Eats only','Lives','Sleeps only','Dances'], answer:1, explain:'Habitat is where an organism lives.'},
        {id:'4-7', q:'Which animal is an insect?', options:['Frog','Butterfly','Shark','Elephant'], answer:1, explain:'Butterflies are insects.'},
        {id:'4-8', q:'Which simple machine helps to lift objects easily?', options:['Pulley','Motor','Battery','Spring'], answer:0, explain:'A pulley reduces effort to lift objects.'},
        {id:'4-9', q:'Which energy form is produced by the Sun?', options:['Mechanical','Chemical','Light','Sound'], answer:2, explain:'Sunlight is light energy.'},
        {id:'4-10', q:'Which is a source of natural light at night?', options:['Moon','Lamp','Torch','Candle'], answer:0, explain:'The Moon reflects sunlight and lights the night.'},
        {id:'4-11', q:'Which object is a magnet attracted to?', options:['Paper','Plastic','Iron nail','Glass'], answer:2, explain:'Magnets attract iron (and some metals).'},
        {id:'4-12', q:'Which food helps build strong bones (contains calcium)?', options:['Candy','Milk','Chips','Soda'], answer:1, explain:'Milk contains calcium for bones.'},
        {id:'4-13', q:'What do we call animals that eat only plants?', options:['Carnivores','Herbivores','Omnivores','Scavengers'], answer:1, explain:'Herbivores eat plants.'},
        {id:'4-14', q:'Which of these is a source of water?', options:['River','Chair','Car','Book'], answer:0, explain:'Rivers are a source of fresh water.'},
        {id:'4-15', q:'Which device tells time?', options:['Thermometer','Clock','Scale','Compass'], answer:1, explain:'Clocks tell time.'},
        {id:'4-16', q:'Which planet do we live on?', options:['Mars','Venus','Earth','Jupiter'], answer:2, explain:'We live on Earth.'},
        {id:'4-17', q:'Which is used to separate sand and water?', options:['Filter','Magnet','Sieve','Evaporation'], answer:2, explain:'A sieve separates larger particles, but filtration or decanting used in different contexts.'},
        {id:'4-18', q:'Which gas is necessary for humans to breathe?', options:['Carbon dioxide','Oxygen','Helium','Hydrogen'], answer:1, explain:'Humans need oxygen to breathe.'},
        {id:'4-19', q:'Which of these is an example of a carnivore?', options:['Cow','Lion','Rabbit','Deer'], answer:1, explain:'Lions eat other animals; they are carnivores.'},
        {id:'4-20', q:'Seeds usually grow into?', options:['Animals','Plants','Rocks','Clouds'], answer:1, explain:'Seeds germinate into plants.'},
        {id:'4-21', q:'Which tool helps measure temperature outside?', options:['Barometer','Thermometer','Ruler','Scale'], answer:1, explain:'Thermometers measure temperature.'},
    {id:'4-22', q:'Which animal stores food in its cheek pouches?', options:['Squirrel','Hamster','Cow','Horse'], answer:1, explain:'Hamsters store food in cheek pouches.'},
    {id:'4-23', q:'Which of these is an example of a non-living thing?', options:['Tree','Rock','Bird','Flower'], answer:1, explain:'Rocks are non-living.'},
    {id:'4-24', q:'Which sense organ helps us hear?', options:['Eyes','Ears','Tongue','Nose'], answer:1, explain:'Ears are for hearing.'},
    {id:'4-25', q:'Which renewable energy comes from moving air?', options:['Solar','Wind','Coal','Gas'], answer:1, explain:'Wind energy uses moving air.'},
    {id:'4-26', q:'Which animal gives us milk?', options:['Cat','Cow','Snake','Frog'], answer:1, explain:'Cows provide milk for humans.'},
    {id:'4-27', q:'Which of these is a seed dispersal method?', options:['Wind','Talking','Sleeping','Reading'], answer:0, explain:'Wind can carry seeds to new places.'},
    {id:'4-28', q:'Which machine makes bread by mixing and baking?', options:['Washing machine','Toaster','Oven','Drill'], answer:2, explain:'An oven bakes food like bread.'},
    {id:'4-29', q:'Which material is used to make glass?', options:['Sand','Wood','Paper','Soil'], answer:0, explain:'Glass is made from heated sand (silica).'},
    {id:'4-30', q:'Which simple machine is a ramp?', options:['Inclined plane','Pulley','Lever','Wheel'], answer:0, explain:'An inclined plane (ramp) helps move objects up.'},
    {id:'4-31', q:'Which animal is known for hopping and making a pouch?', options:['Lion','Kangaroo','Elephant','Sheep'], answer:1, explain:'Kangaroos have pouches and hop.'},
    {id:'4-32', q:'Which force helps keep a ball on the ground?', options:['Magnetism','Gravity','Electricity','Friction'], answer:1, explain:'Gravity pulls objects toward Earth.'},
    {id:'4-33', q:'Which part of plant holds it upright?', options:['Root','Stem','Seed','Fruit'], answer:1, explain:'The stem supports the plant and holds it upright.'},
    {id:'4-34', q:'Which of these is a healthy drink from animals?', options:['Soda','Milk','Oil','Juice'], answer:1, explain:'Milk is a nutritious animal product.'},
    {id:'4-35', q:'Which tool helps a farmer water crops?', options:['Umbrella','Irrigation canal','Microphone','Book'], answer:1, explain:'Irrigation brings water to fields.'},
    {id:'4-36', q:'Which weather tool measures wind speed?', options:['Ammeter','Anemometer','Barometer','Thermometer'], answer:1, explain:'An anemometer measures wind speed.'},
    {id:'4-37', q:'Which part of a plant becomes a fruit?', options:['Root','Stem','Flower','Leaf'], answer:2, explain:'Fruits develop from flowers after pollination.'},
    {id:'4-38', q:'Which animal uses echolocation to find food?', options:['Dog','Bat','Cow','Horse'], answer:1, explain:'Bats use echolocation to navigate and hunt.'},
    {id:'4-39', q:'Which gas fills balloons to make them float?', options:['Carbon dioxide','Hydrogen','Helium','Oxygen'], answer:2, explain:'Helium is lighter than air and used in balloons.'},
    {id:'4-40', q:'Which sense helps us taste food?', options:['Eyes','Nose','Tongue','Ears'], answer:2, explain:'The tongue senses taste.'},
    {id:'4-41', q:'Which is an example of a simple food chain?', options:['Sun → Grass → Cow','Car → Road → Driver','Book → Page → Word','Chair → Leg → Wood'], answer:0, explain:'Sun provides energy to grass, which feeds animals.'},
    {id:'4-42', q:'Which animal has a long neck and eats leaves from tall trees?', options:['Giraffe','Monkey','Rabbit','Cat'], answer:0, explain:'Giraffes use their long necks to reach leaves.'},
    {id:'4-43', q:'Which device helps to find direction using a needle?', options:['Clock','Compass','Scale','Radio'], answer:1, explain:'A compass points to magnetic north.'},
    {id:'4-44', q:'Which color do plants appear because of chlorophyll?', options:['Red','Blue','Green','Yellow'], answer:2, explain:'Chlorophyll makes many plants look green.'},
    {id:'4-45', q:'Which of the following is an insect with many legs?', options:['Ant','Spider','Millipede','Frog'], answer:2, explain:'Millipedes have many legs.'},
    {id:'4-46', q:'Which is used to separate paper from a pile?', options:['Scissors','Glue','Comb','Rubber band'], answer:0, explain:'Scissors can cut paper.'},
    {id:'4-47', q:'Where does rain come from?', options:['Clouds','Mountains','Desert','Rocks'], answer:0, explain:'Rain falls from clouds formed by condensation.'},
    {id:'4-48', q:'Which animal carries its young in a pouch?', options:['Kangaroo','Sheep','Horse','Goat'], answer:0, explain:'Kangaroos are marsupials with pouches.'},
    {id:'4-49', q:'Which grows from a seed?', options:['Tree','Car','House','Rock'], answer:0, explain:'Trees grow from seeds.'},
    {id:'4-50', q:'Which instrument measures how hot something is?', options:['Clock','Thermometer','Ruler','Scale'], answer:1, explain:'A thermometer measures temperature.'}
  ],
      "5": [
        {id:'5-1', q:'Which one is a simple machine?', options:['Pulley','Computer','Phone','Book'], answer:0, explain:'A pulley is a simple machine.'},
        {id:'5-2', q:'Which process causes water to move from plants to the air?', options:['Respiration','Transpiration','Digestion','Condensation'], answer:1, explain:'Transpiration is water vapour loss from plants.'},
        {id:'5-3', q:'Which organ helps in breathing?', options:['Heart','Lungs','Stomach','Liver'], answer:1, explain:'Lungs take in oxygen and remove carbon dioxide.'},
        {id:'5-4', q:'Which is a mixture?', options:['Salt','Sugar','Salt water','Water'], answer:2, explain:'Salt water is a mixture of salt and water.'},
        {id:'5-5', q:'Which gas supports burning?', options:['Nitrogen','Carbon dioxide','Oxygen','Helium'], answer:2, explain:'Oxygen supports combustion.'},
        {id:'5-6', q:'What is the main source of energy for Earth?', options:['Moon','Sun','Wind','Rocks'], answer:1, explain:'The Sun is Earth’s primary energy source.'},
        {id:'5-7', q:'What is the process of plants making food called?', options:['Digestion','Photosynthesis','Respiration','Fermentation'], answer:1, explain:'Photosynthesis is how plants make food.'},
        {id:'5-8', q:'Which animals live in groups called herds?', options:['Lions','Cows','Eagles','Sharks'], answer:1, explain:'Many hoofed animals like cows live in herds.'},
        {id:'5-9', q:'Which instrument measures weight?', options:['Thermometer','Scale','Clock','Ruler'], answer:1, explain:'A scale measures weight.'},
        {id:'5-10', q:'What do bees transfer between flowers?', options:['Seeds','Pollen','Leaves','Soil'], answer:1, explain:'Bees transfer pollen helping pollination.'},
        {id:'5-11', q:'Which rock is formed from molten lava?', options:['Sedimentary','Igneous','Metamorphic','Soil'], answer:1, explain:'Igneous rocks form from cooling lava or magma.'},
        {id:'5-12', q:'Which food group gives quick energy (carbohydrates)?', options:['Fats','Proteins','Vitamins','Carbohydrates'], answer:3, explain:'Carbohydrates are the main quick energy source.'},
        {id:'5-13', q:'Which animal lays eggs and also has feathers?', options:['Bat','Eagle','Cat','Dog'], answer:1, explain:'Eagles are birds; they lay eggs and have feathers.'},
        {id:'5-14', q:'Which is a renewable source of energy?', options:['Coal','Oil','Sun','Natural gas'], answer:2, explain:'Sun (solar) energy is renewable.'},
        {id:'5-15', q:'Which part of blood carries oxygen?', options:['Plasma','Red blood cells','Platelets','Plasma proteins'], answer:1, explain:'Red blood cells carry oxygen using haemoglobin.'},
        {id:'5-16', q:'Which body system helps move the body?', options:['Digestive','Nervous','Muscular','Respiratory'], answer:2, explain:'Muscular system allows movement.'},
        {id:'5-17', q:'Which instrument is used to magnify small objects?', options:['Microscope','Telescope','Stethoscope','Thermometer'], answer:0, explain:'Microscopes magnify tiny objects.'},
        {id:'5-18', q:'Which of the following is a food chain example?', options:['Sun → Grass → Rabbit → Fox','Rock → River → Mountain','Cloud → Rain → Sun','Soil → Seed → Water'], answer:0, explain:'That sequence is a simple food chain.'},
        {id:'5-19', q:'Which process cleans water by boiling and collecting steam?', options:['Filtration','Evaporation-condensation (distillation)','Sedimentation','Magnetism'], answer:1, explain:'Distillation boils water and condenses steam to purify it.'},
        {id:'5-20', q:'Which is NOT a living thing?', options:['Tree','Stone','Bird','Bacterium'], answer:1, explain:'Stone is non-living.'},
         {id:'5-21', q:'Which instrument measures temperature of the body?', options:['Thermometer','Ruler','Scale','Clock'], answer:0, explain:'A thermometer measures body temperature.'},
    {id:'5-22', q:'Which animal is an example of a scavenger?', options:['Vulture','Cow','Sheep','Fish'], answer:0, explain:'Vultures feed on dead animals; they are scavengers.'},
    {id:'5-23', q:'Which food helps build muscles (protein)?', options:['Meat','Sweets','Juice','Salt'], answer:0, explain:'Meat contains protein for muscles.'},
    {id:'5-24', q:'Which process turns solid ice directly to gas?', options:['Melting','Sublimation','Evaporation','Freezing'], answer:1, explain:'Sublimation is solid to gas without passing liquid stage.'},
    {id:'5-25', q:'Which soil type holds water well?', options:['Sandy','Clay','Rocky','Gravel'], answer:1, explain:'Clay has tiny particles and retains water.'},
    {id:'5-26', q:'Which animals are warm-blooded?', options:['Fish','Birds and mammals','Reptiles','Insects'], answer:1, explain:'Birds and mammals maintain internal body temperature.'},
    {id:'5-27', q:'Which is an electric conductor?', options:['Plastic','Glass','Copper','Wood'], answer:2, explain:'Copper is a good conductor of electricity.'},
    {id:'5-28', q:'Which simple machine is a seesaw?', options:['Lever','Pulley','Inclined plane','Wheel'], answer:0, explain:'A seesaw is a type of lever.'},
    {id:'5-29', q:'Which planet is known as the Blue Planet?', options:['Mars','Earth','Venus','Mercury'], answer:1, explain:'Earth appears blue due to its oceans.'},
    {id:'5-30', q:'Which gas do plants give out at night?', options:['Oxygen','Carbon dioxide','Nitrogen','None'], answer:1, explain:'Plants respire and give out CO₂ at night.'},
    {id:'5-31', q:'Which sense helps you feel heat?', options:['Taste','Touch','Smell','Hearing'], answer:1, explain:'Touch receptors sense temperature.'},
    {id:'5-32', q:'Which instrument measures weight of small objects precisely?', options:['Spring balance','Weighing scale','Thermometer','Ruler'], answer:1, explain:'Weighing scales (balances) measure mass/weight accurately.'},
    {id:'5-33', q:'Which part of a plant carries food made in leaves to other parts?', options:['Xylem','Phloem','Root','Seed'], answer:1, explain:'Phloem transports sugars from leaves to plants.'},
    {id:'5-34', q:'Which of these animals is a reptile?', options:['Snake','Frog','Whale','Bird'], answer:0, explain:'Snakes are reptiles.'},
    {id:'5-35', q:'Which form of water is gas?', options:['Ice','Steam','Snow','Frost'], answer:1, explain:'Steam is water in gas form.'},
    {id:'5-36', q:'Which device measures wind direction?', options:['Hygrometer','Anemometer','Wind vane','Thermometer'], answer:2, explain:'A wind vane shows wind direction.'},
    {id:'5-37', q:'Which stage comes after pupa in some insects?', options:['Egg','Larva','Adult','Seed'], answer:2, explain:'After pupa many insects become adults (e.g., butterflies).'},
    {id:'5-38', q:'Which food source comes from plants?', options:['Milk','Honey','Fruits','Meat'], answer:2, explain:'Fruits are produced by plants.'},
    {id:'5-39', q:'Which is used to clean water by removing large particles?', options:['Filtering','Microwaving','Burning','Mixing'], answer:0, explain:'Filtering removes large solid particles.'},
    {id:'5-40', q:'Which animal is known for building dams?', options:['Bee','Beaver','Ant','Fish'], answer:1, explain:'Beavers build dams across streams.'},
    {id:'5-41', q:'Which type of rock is formed by heat and pressure?', options:['Igneous','Sedimentary','Metamorphic','Soil'], answer:2, explain:'Metamorphic rocks form under heat and pressure.'},
    {id:'5-42', q:'Which vitamin is made when skin is exposed to sunlight?', options:['Vitamin C','Vitamin D','Vitamin A','Vitamin B'], answer:1, explain:'Vitamin D is produced in skin with sunlight.'},
    {id:'5-43', q:'Which device measures electric current?', options:['Voltmeter','Ammeter','Thermometer','Hygrometer'], answer:1, explain:'An ammeter measures current.'},
    {id:'5-44', q:'Which process helps separate a soluble solid from a liquid by heating?', options:['Evaporation','Filtration','Sifting','Magnetism'], answer:0, explain:'Evaporation removes liquid leaving the solid behind.'},
    {id:'5-45', q:'Which animal is a nocturnal mammal?', options:['Tiger','Bat','Sheep','Cow'], answer:1, explain:'Bats are active at night.'},
    {id:'5-46', q:'Which food is high in carbohydrates for energy?', options:['Bread','Fish','Oil','Salt'], answer:0, explain:'Bread is rich in carbohydrates.'},
    {id:'5-47', q:'Which of these is an example of erosion?', options:['River cutting rock','Plant growing','Bird flying','Rock forming'], answer:0, explain:'Rivers can wear away rock, an example of erosion.'},
    {id:'5-48', q:'What do you call water when it turns into ice?', options:['Boiling','Freezing','Melting','Evaporation'], answer:1, explain:'Water freezes to form ice.'},
    {id:'5-49', q:'Which is used to check heartbeat?', options:['Stethoscope','Microscope','Telescope','Thermometer'], answer:0, explain:'A stethoscope listens to heartbeats.'},
    {id:'5-50', q:'Which gas is used in the kitchen for cooking in many homes?', options:['Oxygen','Natural gas','Helium','Nitrogen'], answer:1, explain:'Natural gas (methane) is commonly used for cooking.'}
  ],
      "6": [
        {id:'6-1', q:'Cells are the basic unit of which?', options:['Minerals','Life/organisms','Rocks','Water'], answer:1, explain:'Cells are the basic units of life.'},
        {id:'6-2', q:'Which process breaks down food in the stomach?', options:['Photosynthesis','Digestion','Erosion','Cycling'], answer:1, explain:'Digestion breaks down food into nutrients.'},
        {id:'6-3', q:'A circuit that has a break will be?', options:['Closed','Complete','Open','Short'], answer:2, explain:'An open circuit has a break; electricity does not flow.'},
        {id:'6-4', q:'Which is an example of a conductor?', options:['Glass','Rubber','Copper','Wood'], answer:2, explain:'Copper is a good electrical conductor.'},
        {id:'6-5', q:'Which of these is a renewable resource?', options:['Coal','Solar','Petroleum','Natural gas'], answer:1, explain:'Solar energy is renewable.'},
        {id:'6-6', q:'Which device measures electric current?', options:['Voltmeter','Ammeter','Thermometer','Ruler'], answer:1, explain:'An ammeter measures current.'},
        {id:'6-7', q:'Which organ helps in digestion by adding enzymes?', options:['Lungs','Liver','Pancreas','Heart'], answer:2, explain:'Pancreas releases digestive enzymes.'},
        {id:'6-8', q:'Which gas is used by plants in photosynthesis?', options:['Oxygen','Carbon dioxide','Nitrogen','Methane'], answer:1, explain:'Plants use carbon dioxide.'},
        {id:'6-9', q:'What type of mixture can be separated by filtration?', options:['Salt dissolved in water','Sugar dissolved in water','Sand in water','Air'], answer:2, explain:'Sand in water can be separated through filtration.'},
        {id:'6-10', q:'Which phenomenon causes day and night?', options:['Earth orbits Sun','Moon shines at night','Earth rotates on its axis','Sun orbits Earth'], answer:2, explain:'Earth rotation causes day and night.'},
        {id:'6-11', q:'Which is NOT a function of roots?', options:['Absorb water','Fix plant in soil','Make food','Store food'], answer:2, explain:'Roots absorb and store, but leaves make food.'},
        {id:'6-12', q:'Which planet is known as the Red Planet?', options:['Venus','Mars','Jupiter','Saturn'], answer:1, explain:'Mars is called the Red Planet.'},
        {id:'6-13', q:'When ice melts, it becomes?', options:['Gas','Liquid','Solid','Plasma'], answer:1, explain:'Ice becomes liquid water when it melts.'},
        {id:'6-14', q:'Which force opposes motion between two surfaces?', options:['Gravity','Friction','Magnetism','Inertia'], answer:1, explain:'Friction resists relative motion.'},
        {id:'6-15', q:'Which body part helps remove waste from the blood?', options:['Heart','Lungs','Kidneys','Stomach'], answer:2, explain:'Kidneys filter waste from the blood.'},
        {id:'6-16', q:'Which light trend shows colours when white light passes through a prism?', options:['Reflection','Refraction','Dispersion','Absorption'], answer:2, explain:'Dispersion splits white light into colours.'},
        {id:'6-17', q:'Which term describes an animal that eats both plants and animals?', options:['Carnivore','Herbivore','Omnivore','Producer'], answer:2, explain:'Omnivores eat both plants and animals.'},
        {id:'6-18', q:'Which one is a prokaryote?', options:['Bacteria','Plant cell','Animal cell','Fungal cell'], answer:0, explain:'Bacteria are prokaryotic cells.'},
        {id:'6-19', q:'Which process turns milk into curd?', options:['Boiling','Fermentation','Condensation','Sublimation'], answer:1, explain:'Fermentation (bacterial action) turns milk into curd.'},
        {id:'6-20', q:'Which device uses a lens to see distant objects?', options:['Microscope','Magnifier','Telescope','Stethoscope'], answer:2, explain:'A telescope helps view distant objects.'},
        {id:'6-21', q:'Which organ helps pump blood around the body?', options:['Lungs','Kidney','Heart','Stomach'], answer:2, explain:'The heart pumps blood through vessels.'},
    {id:'6-22', q:'Which gas is needed for combustion?', options:['Carbon dioxide','Oxygen','Nitrogen','Argon'], answer:1, explain:'Oxygen supports burning.'},
    {id:'6-23', q:'Which is a magnetized material?', options:['Wood','Iron','Glass','Water'], answer:1, explain:'Iron is attracted by magnets.'},
    {id:'6-24', q:'Which is the process of plants losing water through leaves?', options:['Evaporation','Transpiration','Condensation','Precipitation'], answer:1, explain:'Transpiration is water loss from leaves.'},
    {id:'6-25', q:'Which instrument measures temperature of the air?', options:['Thermometer','Ammeter','Barometer','Hygrometer'], answer:0, explain:'Thermometers measure air temperature.'},
    {id:'6-26', q:'Which type of rock forms from layers of sediment?', options:['Igneous','Sedimentary','Metamorphic','Magma'], answer:1, explain:'Sedimentary rocks form from deposited layers.'},
    {id:'6-27', q:'Which is the main gas in air?', options:['Oxygen','Nitrogen','Carbon dioxide','Hydrogen'], answer:1, explain:'Nitrogen makes up about 78% of air.'},
    {id:'6-28', q:'Which body part helps us taste sour and sweet?', options:['Nose','Tongue','Ear','Eye'], answer:1, explain:'The tongue detects taste.'},
    {id:'6-29', q:'Which animal lays eggs and breathes air?', options:['Fish','Frog','Bird','Worm'], answer:2, explain:'Birds lay eggs and breathe air.'},
    {id:'6-30', q:'Which device shows changes in air pressure?', options:['Barometer','Thermometer','Hygrometer','Anemometer'], answer:0, explain:'Barometers measure air pressure.'},
    {id:'6-31', q:'Which organ stores bile made by the liver?', options:['Pancreas','Gallbladder','Spleen','Kidney'], answer:1, explain:'The gallbladder stores bile.'},
    {id:'6-32', q:'Which of these is a vertebrate?', options:['Earthworm','Snail','Fish','Insect'], answer:2, explain:'Fish have backbones (vertebrates).'},
    {id:'6-33', q:'Which object is transparent and lets light pass?', options:['Wood','Glass','Metal','Brick'], answer:1, explain:'Glass lets light through and is transparent.'},
    {id:'6-34', q:'Which process forms clouds?', options:['Evaporation then condensation','Melting','Freezing','Sublimation'], answer:0, explain:'Water evaporates and then condenses into clouds.'},
    {id:'6-35', q:'Which force keeps the moon in orbit around Earth?', options:['Magnetism','Gravity','Electricity','Friction'], answer:1, explain:'Gravity holds the moon in orbit.'},
    {id:'6-36', q:'Which plant part is usually green and performs photosynthesis?', options:['Root','Leaf','Root hair','Seed'], answer:1, explain:'Leaves contain chlorophyll for photosynthesis.'},
    {id:'6-37', q:'Which device converts electrical energy to light?', options:['Motor','LED bulb','Heater','Bell'], answer:1, explain:'LED bulbs convert electricity to light.'},
    {id:'6-38', q:'Which property measures how much matter an object has?', options:['Volume','Mass','Speed','Temperature'], answer:1, explain:'Mass measures the amount of matter.'},
    {id:'6-39', q:'Which is used to separate salt from water by evaporation?', options:['Distillation','Filtration','Sieve','Magnet'], answer:0, explain:'Distillation recovers water by evaporating and condensing.'},
    {id:'6-40', q:'Which condition helps seeds to germinate fastest?', options:['No water','Cold and frozen','Warmth and moisture','Complete darkness and dryness'], answer:2, explain:'Warmth with moisture encourages germination.'},
    {id:'6-41', q:'Which gas do animals breathe in for life?', options:['Carbon dioxide','Oxygen','Helium','Neon'], answer:1, explain:'Animals need oxygen for respiration.'},
    {id:'6-42', q:'Which type of animal has feathers?', options:['Fish','Birds','Mammals','Reptiles'], answer:1, explain:'Birds have feathers.'},
    {id:'6-43', q:'Which machine helps move large loads with wheels?', options:['Pulley','Wheel and axle','Inclined plane','Lever'], answer:1, explain:'Wheel and axle systems help transport loads.'},
    {id:'6-44', q:'Which is the natural satellite of Earth?', options:['Sun','Moon','Mars','Venus'], answer:1, explain:'The Moon orbits Earth as its satellite.'},
    {id:'6-45', q:'Which organ helps keep balance in the body?', options:['Eyes','Inner ear','Stomach','Lungs'], answer:1, explain:'The inner ear contributes to balance.'},
    {id:'6-46', q:'Which energy form is stored in food?', options:['Potential chemical energy','Sound energy','Light energy','Kinetic energy'], answer:0, explain:'Food contains stored chemical energy.'},
    {id:'6-47', q:'Which instrument is used to look at very small things?', options:['Telescope','Microscope','Thermometer','Compass'], answer:1, explain:'Microscopes magnify tiny objects.'},
    {id:'6-48', q:'Which process uses plants to make oxygen and glucose?', options:['Respiration','Photosynthesis','Digestion','Combustion'], answer:1, explain:'Photosynthesis produces oxygen and glucose.'},
    {id:'6-49', q:'Which of these animals is a herbivore?', options:['Lion','Cow','Tiger','Wolf'], answer:1, explain:'Cows eat plants and are herbivores.'},
    {id:'6-50', q:'Which substance is a liquid at room temperature?', options:['Iron','Mercury','Stone','Glass'], answer:1, explain:'Mercury is a metal that is liquid at room temperature.'}
  ],
    
      "7": [
        {id:'7-1', q:'Which system includes heart and blood vessels?', options:['Digestive','Nervous','Circulatory','Respiratory'], answer:2, explain:'Circulatory system includes the heart and vessels.'},
        {id:'7-2', q:'Which part of the eye controls amount of light entering?', options:['Retina','Iris','Lens','Cornea'], answer:1, explain:'Iris adjusts pupil size to control light.'},
        {id:'7-3', q:'Which is a chemical change?', options:['Ice melting','Rusting of iron','Tearing paper','Freezing water'], answer:1, explain:'Rusting changes composition — chemical change.'},
        {id:'7-4', q:'Which one stores genetic information?', options:['Protein','DNA','Water','Salts'], answer:1, explain:'DNA contains genetic code.'},
        {id:'7-5', q:'Which device uses electromagnetism to make motion?', options:['Battery','Speaker','Electric motor','Solar panel'], answer:2, explain:'Electric motors convert electricity into motion via electromagnetism.'},
        {id:'7-6', q:'Which gas causes greenhouse effect when in excess?', options:['Oxygen','Carbon dioxide','Argon','Helium'], answer:1, explain:'CO₂ traps heat and contributes to the greenhouse effect.'},
        {id:'7-7', q:'Which bones protect the brain?', options:['Ribs','Skull','Femur','Spine'], answer:1, explain:'The skull surrounds and protects the brain.'},
        {id:'7-8', q:'Which particles orbit the nucleus of an atom?', options:['Protons','Neutrons','Electrons','Photons'], answer:2, explain:'Electrons orbit the nucleus.'},
        {id:'7-9', q:'Which is a conductor of heat?', options:['Wood','Plastic','Metal','Air'], answer:2, explain:'Metals generally conduct heat well.'},
        {id:'7-10', q:'Which term describes the movement of water from roots to leaves?', options:['Transpiration stream','Photosynthesis','Pollination','Evaporation'], answer:0, explain:'The transpiration stream moves water up the plant.'},
        {id:'7-11', q:'Which is a sign of chemical reaction?', options:['Change of shape','Change of color and gas formation','Change of size','Change of position'], answer:1, explain:'Color change, gas, or temperature change indicate chemical reactions.'},
        {id:'7-12', q:'Which organ helps remove CO₂ from the blood?', options:['Lungs','Liver','Kidney','Brain'], answer:0, explain:'Lungs exhale carbon dioxide from the blood.'},
        {id:'7-13', q:'What causes tides on Earth?', options:['Wind','Moon\'s gravity','Sunlight','Earthquakes'], answer:1, explain:'The Moon’s gravity (and Sun) influence tides.'},
        {id:'7-14', q:'Which is an example of a reversible change?', options:['Baking cake','Melting ice','Rusting','Burning wood'], answer:1, explain:'Melting ice can be reversed by freezing.'},
        {id:'7-15', q:'Which organelle is called the powerhouse of the cell?', options:['Ribosome','Chloroplast','Mitochondria','Nucleus'], answer:2, explain:'Mitochondria generate energy in cells.'},
        {id:'7-16', q:'Which kind of mirror converges light?', options:['Plane mirror','Concave mirror','Convex mirror','None'], answer:1, explain:'Concave mirrors can converge (focus) light.'},
        {id:'7-17', q:'Which force keeps planets in orbit around the Sun?', options:['Friction','Electrostatic','Gravity','Magnetism'], answer:2, explain:'Gravity keeps planets in orbit.'},
        {id:'7-18', q:'Which method separates insoluble solids from liquids?', options:['Filtration','Distillation','Evaporation','Crystallization'], answer:0, explain:'Filtration removes insoluble solids.'},
        {id:'7-19', q:'Which tissue connects muscles to bones?', options:['Veins','Ligaments','Tendons','Cartilage'], answer:2, explain:'Tendons attach muscle to bone.'},
        {id:'7-20', q:'Which category are green plants that produce their own food?', options:['Autotrophs','Heterotrophs','Fungi','Consumers'], answer:0, explain:'Autotrophs make their own food.'},
        {id:'7-21', q:'Which organ controls hormones in the body?', options:['Brain','Skin','Pancreas','Endocrine glands'], answer:3, explain:'Endocrine glands (e.g., thyroid) secrete hormones.'},
    {id:'7-22', q:'Which process splits water into hydrogen and oxygen using electricity?', options:['Photosynthesis','Electrolysis','Combustion','Digestion'], answer:1, explain:'Electrolysis separates water into gases using electric current.'},
    {id:'7-23', q:'Which material is magnetic?', options:['Plastic','Iron','Glass','Wood'], answer:1, explain:'Iron is attracted to magnets.'},
    {id:'7-24', q:'Which gas is most harmful in excess for climate change?', options:['Oxygen','Carbon dioxide','Nitrogen','Helium'], answer:1, explain:'CO₂ contributes significantly to global warming.'},
    {id:'7-25', q:'Which organ helps in sensing smell?', options:['Tongue','Nose','Ear','Eye'], answer:1, explain:'The nose detects smells.'},
    {id:'7-26', q:'Which process occurs in green leaves to make glucose?', options:['Respiration','Photosynthesis','Digestion','Fermentation'], answer:1, explain:'Photosynthesis produces glucose in leaves.'},
    {id:'7-27', q:'Which type of rock can change under heat and pressure?', options:['Igneous','Sedimentary','Metamorphic','Soil'], answer:2, explain:'Metamorphic rocks form from other rocks under heat/pressure.'},
    {id:'7-28', q:'Which is NOT a function of the skeleton?', options:['Support','Protection','Making food','Movement'], answer:2, explain:'Skeletons support, protect and help movement; they do not make food.'},
    {id:'7-29', q:'Which device measures electric potential difference?', options:['Ammeter','Voltmeter','Ruler','Thermometer'], answer:1, explain:'Voltage is measured with a voltmeter.'},
    {id:'7-30', q:'Which organ helps perform gas exchange in humans?', options:['Skin','Heart','Lungs','Kidneys'], answer:2, explain:'Lungs exchange oxygen and carbon dioxide.'},
    {id:'7-31', q:'Which energy transformation happens in a torch (flashlight)?', options:['Chemical to light','Sound to electrical','Light to chemical','Thermal to chemical'], answer:0, explain:'Batteries (chemical) power a bulb producing light.'},
    {id:'7-32', q:'Which term describes inherited features passed from parents?', options:['Evolution','Heredity','Mutation','Extinction'], answer:1, explain:'Heredity passes traits from parents to offspring.'},
    {id:'7-33', q:'Which kind of bond is formed by electrical attraction between ions?', options:['Covalent','Ionic','Metallic','Hydrogen'], answer:1, explain:'Ionic bonds form between charged ions.'},
    {id:'7-34', q:'Which cell part helps make proteins?', options:['Nucleus','Ribosome','Vacuole','Mitochondria'], answer:1, explain:'Ribosomes assemble proteins from amino acids.'},
    {id:'7-35', q:'Which gas is produced by yeast during fermentation?', options:['Oxygen','Carbon dioxide','Nitrogen','Helium'], answer:1, explain:'Yeast produces CO₂ during fermentation.'},
    {id:'7-36', q:'Which wave has the longest wavelength?', options:['X-ray','Radio wave','Visible light','Ultraviolet'], answer:1, explain:'Radio waves have very long wavelengths.'},
    {id:'7-37', q:'Which process can change a liquid into a solid?', options:['Melting','Freezing','Evaporation','Condensation'], answer:1, explain:'Freezing turns liquid to solid.'},
    {id:'7-38', q:'Which gland produces insulin?', options:['Thyroid','Pancreas','Adrenal','Pituitary'], answer:1, explain:'The pancreas secretes insulin.'},
    {id:'7-39', q:'Which organ stores and concentrates bile?', options:['Liver','Gallbladder','Stomach','Pancreas'], answer:1, explain:'The gallbladder stores bile from the liver.'},
    {id:'7-40', q:'Which instrument measures the volume of a liquid precisely?', options:['Measuring cylinder','Balance','Thermometer','Ruler'], answer:0, explain:'Measuring cylinders show liquid volumes.'},
    {id:'7-41', q:'Which type of reproduction involves two parents?', options:['Asexual','Sexual','Cloning','Budding'], answer:1, explain:'Sexual reproduction involves male and female parents.'},
    {id:'7-42', q:'Which is the largest organ in the human body?', options:['Heart','Skin','Liver','Brain'], answer:1, explain:'Skin is the body\'s largest organ.'},
    {id:'7-43', q:'Which particle is positively charged in an atom?', options:['Electron','Neutron','Proton','Photon'], answer:2, explain:'Protons carry positive charge.'},
    {id:'7-44', q:'Which gas do plants store for photosynthesis?', options:['Oxygen','Carbon dioxide','Nitrogen','Methane'], answer:1, explain:'Plants use carbon dioxide in photosynthesis.'},
    {id:'7-45', q:'Which instrument measures the acidity of a solution?', options:['Thermometer','pH meter','Voltmeter','Ammeter'], answer:1, explain:'pH meters measure acidity or alkalinity.'},
    {id:'7-46', q:'Which is used to separate mixtures by boiling point?', options:['Filtration','Distillation','Magnetism','Sieving'], answer:1, explain:'Distillation separates components by boiling/condensing.'},
    {id:'7-47', q:'Which organelle contains chlorophyll?', options:['Mitochondrion','Chloroplast','Nucleus','Ribosome'], answer:1, explain:'Chloroplasts contain chlorophyll for photosynthesis.'},
    {id:'7-48', q:'Which phenomenon causes echoes?', options:['Reflection of sound','Absorption','Transmission','Refraction'], answer:0, explain:'Sound echoes when it bounces off surfaces.'},
    {id:'7-49', q:'Which gas is formed when acid reacts with some metals?', options:['Hydrogen','Oxygen','Nitrogen','Helium'], answer:0, explain:'Hydrogen gas is often released when acids react with metals.'},
    {id:'7-50', q:'Which is a renewable resource used for energy?', options:['Coal','Oil','Solar','Natural gas'], answer:2, explain:'Solar energy is renewable and inexhaustible.'}
      ],
      "8": [
        {id:'8-1', q:'Which property causes light to change direction when entering glass?', options:['Reflection','Refraction','Diffusion','Absorption'], answer:1, explain:'Refraction changes light direction in different media.'},
        {id:'8-2', q:'Which is a chemical reaction example?', options:['Evaporation','.Rusting','Melting','Freezing'], answer:1, explain:'Rusting is a chemical reaction.'},
        {id:'8-3', q:'Which part of the ear identifies pitch and loudness?', options:['Outer ear','Cochlea','Eardrum','Pinna'], answer:1, explain:'The cochlea processes sound frequencies.'},
        {id:'8-4', q:'Which process helps water return to the Earth from clouds?', options:['Transpiration','Condensation','Precipitation','Evaporation'], answer:2, explain:'Precipitation (rain/snow) brings water down.'},
        {id:'8-5', q:'Which energy cannot be transported without matter?', options:['Sound','Light','Radio','X-ray'], answer:0, explain:'Sound needs a medium (matter) to travel.'},
        {id:'8-6', q:'Which process releases energy by breaking down food?', options:['Photosynthesis','Respiration','Sublimation','Condensation'], answer:1, explain:'Cellular respiration releases energy from food.'},
        {id:'8-7', q:'What happens to light when it bounces off a mirror?', options:['Absorption','Refraction','Reflection','Diffraction'], answer:2, explain:'Reflection is light bouncing off a surface.'},
        {id:'8-8', q:'Which device magnifies distant objects?', options:['Microscope','Telescope','Thermometer','Hygrometer'], answer:1, explain:'Telescopes magnify distant objects.'},
        {id:'8-9', q:'Which is an acidic substance?', options:['Lemon juice','Soap solution','Baking soda','Water'], answer:0, explain:'Lemon juice is acidic.'},
        {id:'8-10', q:'Which wave needs no material to travel?', options:['Sound','Water','Light','Earthquake'], answer:2, explain:'Light (electromagnetic) can travel through vacuum.'},
        {id:'8-11', q:'Which gas is most abundant in Earth\'s atmosphere?', options:['Oxygen','Hydrogen','Nitrogen','Carbon dioxide'], answer:2, explain:'Nitrogen makes up about 78% of the atmosphere.'},
        {id:'8-12', q:'Which instrument measures humidity?', options:['Barometer','Hygrometer','Thermometer','Anemometer'], answer:1, explain:'Hygrometers measure humidity.'},
        {id:'8-13', q:'Which process uses carbon dioxide and sunlight to make glucose?', options:['Respiration','Photosynthesis','Fermentation','Combustion'], answer:1, explain:'Photosynthesis creates glucose.'},
        {id:'8-14', q:'Which layer of Earth is liquid?', options:['Crust','Mantle','Outer core','Inner core'], answer:2, explain:'The outer core is molten (liquid metal).'},
        {id:'8-15', q:'Which property does NOT change in chemical reaction?', options:['Colour','State','Mass (total)','Odour'], answer:2, explain:'Mass is conserved overall in chemical reactions.'},
        {id:'8-16', q:'Which radiation has the shortest wavelength?', options:['Radio','Microwave','X-ray','Infrared'], answer:2, explain:'X-rays have shorter wavelengths than visible light.'},
        {id:'8-17', q:'Which part of the plant carries water up from the roots?', options:['Xylem','Phloem','Leaf','Flower'], answer:0, explain:'Xylem transports water and minerals.'},
        {id:'8-18', q:'Which behaviour shows a reflex action?', options:['Thinking','Blinking when bright light','Studying','Learning'], answer:1, explain:'Blinking from bright light is reflexive.'},
        {id:'8-19', q:'Which acid is present in stomach?', options:['Hydrochloric acid','Sulfuric acid','Nitric acid','Acetic acid'], answer:0, explain:'Stomach contains hydrochloric acid for digestion.'},
        {id:'8-20', q:'Which unit measures electric resistance?', options:['Volt','Ampere','Ohm','Watt'], answer:2, explain:'Resistance is measured in ohms (Ω).'},
        {id:'8-21', q:'Which phenomenon makes a pencil look bent in a glass of water?', options:['Reflection','Diffraction','Refraction','Absorption'], answer:2, explain:'Refraction bends light as it passes between media.'},
    {id:'8-22', q:'Which is used to detect cracks in metals using sound?', options:['Ultrasound','Microscope','Thermometer','Compass'], answer:0, explain:'Ultrasound can reveal internal defects.'},
    {id:'8-23', q:'Which type of reaction releases energy to surroundings?', options:['Endothermic','Exothermic','Neutral','Isothermal'], answer:1, explain:'Exothermic reactions release heat.'},
    {id:'8-24', q:'Which device converts chemical energy to electrical energy?', options:['Solar cell','Battery','Generator','Motor'], answer:1, explain:'Batteries produce electrical energy from chemical reactions.'},
    {id:'8-25', q:'Which organ controls the body using electrical signals?', options:['Lungs','Heart','Brain','Liver'], answer:2, explain:'The brain sends electrical signals through the nervous system.'},
    {id:'8-26', q:'Which process explains how fossils form?', options:['Erosion','Sedimentation and burial','Combustion','Evaporation'], answer:1, explain:'Fossils form when organisms are buried and minerals replace tissues.'},
    {id:'8-27', q:'Which instrument measures very small electric current?', options:['Voltmeter','Ammeter','Galvanometer','Thermometer'], answer:2, explain:'Galvanometers detect small currents.'},
    {id:'8-28', q:'Which layer protects Earth from harmful UV radiation?', options:['Troposphere','Stratosphere (ozone layer)','Mesosphere','Exosphere'], answer:1, explain:'The ozone layer in the stratosphere absorbs UV.'},
    {id:'8-29', q:'Which force resists change of motion of an object?', options:['Gravity','Inertia','Friction','Magnetism'], answer:1, explain:'Inertia is the tendency to resist changes in motion.'},
    {id:'8-30', q:'Which type of mirror always forms a virtual image?', options:['Concave (for some positions)','Convex','Plane','None'], answer:1, explain:'Convex mirrors form virtual, diminished images for all object positions.'},
    {id:'8-31', q:'Which property of sound depends on frequency?', options:['Loudness','Pitch','Duration','Speed'], answer:1, explain:'Pitch depends on frequency; higher frequency = higher pitch.'},
    {id:'8-32', q:'Which term describes change in state from gas to solid directly?', options:['Sublimation','Deposition','Condensation','Freezing'], answer:1, explain:'Deposition (or desublimation) is gas to solid.'},
    {id:'8-33', q:'Which organelle in plant cells stores starch?', options:['Nucleus','Chloroplast','Vacuole','Ribosome'], answer:2, explain:'Vacuoles can store starch and other substances.'},
    {id:'8-34', q:'Which instrument measures the angle of inclination for slopes?', options:['Protractor','Thermometer','Barometer','Microscope'], answer:0, explain:'Protractors measure angles.'},
    {id:'8-35', q:'Which gas is commonly used in balloons and is lighter than air?', options:['Oxygen','Helium','Carbon dioxide','Argon'], answer:1, explain:'Helium is lighter than air and used in balloons.'},
    {id:'8-36', q:'Which process converts glucose to provide energy in cells?', options:['Photosynthesis','Cellular respiration','Fermentation','Osmosis'], answer:1, explain:'Cellular respiration releases energy from glucose.'},
    {id:'8-37', q:'Which climate zone is hot and dry with few plants?', options:['Tundra','Desert','Rainforest','Temperate'], answer:1, explain:'Deserts are hot and dry with sparse vegetation.'},
    {id:'8-38', q:'Which property of a material resists flow of electric current?', options:['Resistance','Capacitance','Inductance','Conductance'], answer:0, explain:'Resistance measures how much a material resists current.'},
    {id:'8-39', q:'Which optical instrument is best for observing distant stars?', options:['Microscope','Telescope','Thermometer','Seismograph'], answer:1, explain:'Telescopes view distant celestial objects.'},
    {id:'8-40', q:'Which is an example of a renewable energy source?', options:['Coal','Oil','Wind','Oil shale'], answer:2, explain:'Wind energy renews naturally and does not run out.'},
    {id:'8-41', q:'Which mineral is used to make glass?', options:['Quartz (silica)','Iron ore','Copper ore','Coal'], answer:0, explain:'Silica (quartz) is the main component of glass.'},
    {id:'8-42', q:'Which unit measures frequency of waves?', options:['Volt','Hertz','Ohm','Newton'], answer:1, explain:'Frequency is measured in hertz (Hz).'},
    {id:'8-43', q:'Which gas is given out by plants during the day?', options:['Oxygen','Carbon dioxide','Methane','Ammonia'], answer:0, explain:'Plants release oxygen during photosynthesis.'},
    {id:'8-44', q:'Which substance speeds up a chemical reaction without being used?', options:['Catalyst','Solvent','Reactant','Product'], answer:0, explain:'Catalysts lower activation energy and are unchanged.'},
    {id:'8-45', q:'Which process moves materials from high to low concentration?', options:['Active transport','Diffusion','Photosynthesis','Respiration'], answer:1, explain:'Diffusion is movement from high to low concentration.'},
    {id:'8-46', q:'Which phenomenon bends light around small obstacles creating patterns?', options:['Refraction','Reflection','Diffraction','Absorption'], answer:2, explain:'Diffraction causes bending and interference patterns.'},
    {id:'8-47', q:'Which layer of the atmosphere contains most weather events?', options:['Troposphere','Stratosphere','Mesosphere','Thermosphere'], answer:0, explain:'Weather occurs mainly in the troposphere.'},
    {id:'8-48', q:'Which instrument records ground tremors during earthquakes?', options:['Seismograph','Barometer','Hygrometer','Anemometer'], answer:0, explain:'Seismographs record earthquake vibrations.'},
    {id:'8-49', q:'Which particle has a negative electric charge?', options:['Proton','Neutron','Electron','Photon'], answer:2, explain:'Electrons are negatively charged.'},
    {id:'8-50', q:'Which is a greenhouse gas emitted from burning fossil fuels?', options:['Oxygen','Carbon dioxide','Argon','Neon'], answer:1, explain:'CO₂ is released when fossil fuels are burned.'}
  ],
      "9": [
        {id:'9-1', q:'Which subatomic particle has no charge?', options:['Electron','Proton','Neutron','Positron'], answer:2, explain:'Neutrons are neutral (no charge).'},
        {id:'9-2', q:'Which law relates force, mass and acceleration?', options:['Ohm\'s law','Hooke\'s law','Newton\'s second law','Law of conservation of mass'], answer:2, explain:'F = ma is Newton’s second law.'},
        {id:'9-3', q:'Which is a balanced chemical equation example?', options:['H2 + O2 → H2O','2H2 + O2 → 2H2O','H + O → H2O','O2 → O'], answer:1, explain:'Stoichiometric coefficients balance atoms.'},
        {id:'9-4', q:'Which term describes inherited traits?', options:['Adaptation','Mutation','Heredity','Disaster'], answer:2, explain:'Heredity passes traits from parents to offspring.'},
        {id:'9-5', q:'Which instrument measures electric potential difference?', options:['Ammeter','Voltmeter','Thermometer','Galvanometer'], answer:1, explain:'Voltage is measured with a voltmeter.'},
        {id:'9-6', q:'Which process forms a new organism from one parent (no fusion)?', options:['Sexual reproduction','Asexual reproduction','Fertilization','Cross-pollination'], answer:1, explain:'Asexual reproduction creates offspring without gamete fusion.'},
        {id:'9-7', q:'Which element has atomic number 1?', options:['Oxygen','Hydrogen','Helium','Carbon'], answer:1, explain:'Hydrogen has atomic number 1.'},
        {id:'9-8', q:'Which is not a conductor of electricity?', options:['Copper','Aluminum','Glass','Silver'], answer:2, explain:'Glass is an insulator.'},
        {id:'9-9', q:'Which process increases speed in an object?', options:['Deceleration','Acceleration','Balanced forces','Equilibrium'], answer:1, explain:'Acceleration increases velocity over time.'},
        {id:'9-10', q:'Which is the process of break down of glucose to yield energy?', options:['Photosynthesis','Respiration','Combustion','Hydrolysis'], answer:1, explain:'Cellular respiration breaks down glucose to release energy.'},
        {id:'9-11', q:'Which group in periodic table contains noble gases?', options:['Group 1','Group 2','Group 18','Group 7'], answer:2, explain:'Group 18 elements are noble gases (inert gases).'},
        {id:'9-12', q:'Which is a green-house gas?', options:['Oxygen','Nitrogen','Carbon dioxide','Argon'], answer:2, explain:'CO₂ is a greenhouse gas that traps heat.'},
        {id:'9-13', q:'Which instrument measures the mass of a sample?', options:['Spring balance','Triple beam balance','Stopwatch','Ruler'], answer:1, explain:'Balances give accurate mass measurements.'},
        {id:'9-14', q:'Which is an example of a reversible physical change?', options:['Burning paper','Rusting iron','Melting and freezing of water','Cooking egg'], answer:2, explain:'Melting and freezing of water is reversible.'},
        {id:'9-15', q:'Which organ system controls hormones?', options:['Circulatory','Endocrine','Digestive','Skeletal'], answer:1, explain:'Endocrine glands release hormones.'},
        {id:'9-16', q:'What do we call the speed in a given direction?', options:['Speed','Velocity','Momentum','Acceleration'], answer:1, explain:'Velocity is speed with direction.'},
        {id:'9-17', q:'Which process is used to separate soluble solids from liquids by boiling and condensing?', options:['Filtration','Distillation','Magnetism','Centrifuging'], answer:1, explain:'Distillation separates by boiling and condensing.'},
        {id:'9-18', q:'Which cell organelle contains chlorophyll?', options:['Mitochondria','Chloroplast','Nucleus','Ribosome'], answer:1, explain:'Chloroplasts carry chlorophyll for photosynthesis.'},
        {id:'9-19', q:'Which phenomenon explains day length change through the year?', options:['Earth\'s rotation','Earth\'s revolution around Sun and tilt','Moon phases','Tides'], answer:1, explain:'Earth’s tilt and orbit change day length by season.'},
        {id:'9-20', q:'Which statement is true for acids?', options:['Taste bitter','Turn blue litmus red','Conduct electricity as solids','Are slippery'], answer:1, explain:'Acids turn blue litmus paper red.'},
        {id:'9-21', q:'Which process converts sugar to alcohol in absence of oxygen?', options:['Photosynthesis','Fermentation','Oxidation','Combustion'], answer:1, explain:'Fermentation produces alcohol and CO₂ using yeast.'},
    {id:'9-22', q:'Which law states that mass is conserved in a closed system?', options:['Newton\'s law','Law of conservation of mass','Boyle\'s law','Hooke\'s law'], answer:1, explain:'Mass remains constant in chemical reactions for a closed system.'},
    {id:'9-23', q:'Which metal is least reactive among these?', options:['Sodium','Gold','Potassium','Calcium'], answer:1, explain:'Gold is chemically unreactive compared to alkali metals.'},
    {id:'9-24', q:'Which process moves water from soil into plant roots?', options:['Osmosis','Diffusion','Condensation','Evaporation'], answer:0, explain:'Osmosis moves water across semi-permeable membranes into roots.'},
    {id:'9-25', q:'Which is used to measure electric charge?', options:['Coulomb','Newton','Volt','Ohm'], answer:0, explain:'Coulomb (C) is the SI unit of electric charge.'},
    {id:'9-26', q:'Which galaxy is our solar system in?', options:['Andromeda','Milky Way','Whirlpool','Sombrero'], answer:1, explain:'The solar system lies within the Milky Way galaxy.'},
    {id:'9-27', q:'Which is a property of bases?', options:['Turn red litmus blue','Smell sweet','Are sour','Are oily'], answer:0, explain:'Bases turn red litmus paper blue.'},
    {id:'9-28', q:'Which is an example of energy conversion in a hydroelectric plant?', options:['Kinetic → Electrical','Chemical → Thermal','Sound → Light','Thermal → Chemical'], answer:0, explain:'Moving water (kinetic) turns turbines to make electricity.'},
    {id:'9-29', q:'Which particle determines the identity of an element?', options:['Electron','Proton','Neutron','Photon'], answer:1, explain:'Protons define the element\'s atomic number.'},
    {id:'9-30', q:'Which effect explains redshift of distant galaxies?', options:['Doppler effect','Photoelectric effect','Greenhouse effect','Refraction'], answer:0, explain:'The Doppler effect causes spectral lines to shift due to motion.'},
    {id:'9-31', q:'Which process is used to make fresh water from seawater?', options:['Filtration','Distillation (desalination)','Combustion','Sublimation'], answer:1, explain:'Desalination removes salt to produce fresh water.'},
    {id:'9-32', q:'Which reaction type exchanges ions between reactants?', options:['Combination','Displacement','Double displacement','Decomposition'], answer:2, explain:'Double displacement swaps ions between compounds.'},
    {id:'9-33', q:'Which term describes the mass per unit volume?', options:['Force','Density','Weight','Pressure'], answer:1, explain:'Density = mass / volume.'},
    {id:'9-34', q:'Which electromagnetic wave has higher energy than visible light?', options:['Infrared','Radio','Ultraviolet','Microwave'], answer:2, explain:'Ultraviolet has more energy than visible light.'},
    {id:'9-35', q:'Which process uses microorganisms to clean wastewater?', options:['Sedimentation','Biological treatment','Distillation','Centrifuging'], answer:1, explain:'Biological treatments use microbes to break down pollutants.'},
    {id:'9-36', q:'Which vitamin helps in blood clotting?', options:['Vitamin C','Vitamin K','Vitamin A','Vitamin B12'], answer:1, explain:'Vitamin K is important for blood clotting.'},
    {id:'9-37', q:'Which property of light is measured in nanometers?', options:['Amplitude','Frequency','Wavelength','Speed'], answer:2, explain:'Wavelength of light is often measured in nm.'},
    {id:'9-38', q:'Which is the subatomic particle that orbits the nucleus?', options:['Proton','Neutron','Electron','Quark'], answer:2, explain:'Electrons orbit around the nucleus.'},
    {id:'9-39', q:'Which organelle produces ATP in cells?', options:['Ribosome','Mitochondrion','Nucleus','Chloroplast'], answer:1, explain:'Mitochondria generate ATP for cellular energy.'},
    {id:'9-40', q:'Which is an endothermic process?', options:['Combustion','Melting ice to water','Freezing water','Rusting iron'], answer:1, explain:'Melting absorbs heat (endothermic).'},
    {id:'9-41', q:'Which unit measures work or energy?', options:['Newton','Joule','Pascal','Watt'], answer:1, explain:'Energy/work is measured in joules (J).'},
    {id:'9-42', q:'Which law says pressure and volume of a gas are inversely related (at fixed temp)?', options:['Boyle\'s law','Charles\' law','Newton\'s law','Hooke\'s law'], answer:0, explain:'Boyle\'s law states PV = constant at constant T.'},
    {id:'9-43', q:'Which device transforms alternating current (AC) to different voltage?', options:['Rectifier','Transformer','Battery','Generator'], answer:1, explain:'Transformers change AC voltages.'},
    {id:'9-44', q:'Which process produces glucose in plants?', options:['Respiration','Photosynthesis','Combustion','Oxidation'], answer:1, explain:'Photosynthesis makes glucose from CO₂ and water.'},
    {id:'9-45', q:'Which gas is released during respiration by animals?', options:['Oxygen','Carbon dioxide','Helium','Nitrogen'], answer:1, explain:'Animals exhale CO₂ as a respiration byproduct.'},
    {id:'9-46', q:'Which material is used as a semiconductor in electronics?', options:['Copper','Silicon','Iron','Wood'], answer:1, explain:'Silicon is a common semiconductor material.'},
    {id:'9-47', q:'Which method separates mixtures by particle size using a mesh?', options:['Filtration','Sieving','Distillation','Centrifugation'], answer:1, explain:'Sieving separates particles by size.'},
    {id:'9-48', q:'Which branch of science studies inheritance and genes?', options:['Ecology','Genetics','Astronomy','Geology'], answer:1, explain:'Genetics studies heredity and genes.'},
    {id:'9-49', q:'Which is used to measure atmospheric pressure?', options:['Thermometer','Barometer','Hygrometer','Anemometer'], answer:1, explain:'Barometers measure atmospheric pressure.'},
    {id:'9-50', q:'Which phenomenon is caused by the Earth\'s rotation?', options:['Seasons','Day and night','Tides only','Volcanoes'], answer:1, explain:'Earth\'s rotation causes day and night.'}
  ],
      "10": [
        {id:'10-1', q:'Which bond involves sharing of electron pairs?', options:['Ionic','Covalent','Metallic','Hydrogen'], answer:1, explain:'Covalent bonds share electron pairs.'},
        {id:'10-2', q:'Stoichiometry in chemical reactions is used to calculate?', options:['Mass only','moles and masses of reactants/products','Colors','Density'], answer:1, explain:'Stoichiometry relates mole ratios in reactions.'},
        {id:'10-3', q:'Which law states energy cannot be created or destroyed?', options:['Newton\'s law','Law of conservation of energy','Hooke\'s law','Boyle\'s law'], answer:1, explain:'Conservation of energy states total energy remains constant.'},
        {id:'10-4', q:'Which electromagnetic wave has the highest energy?', options:['Radio','Microwave','X-ray','Infrared'], answer:2, explain:'X-rays are higher energy than infrared and visible light.'},
        {id:'10-5', q:'Which process converts ADP to ATP in mitochondria?', options:['Photosynthesis','Cellular respiration (oxidative phosphorylation)','Diffusion','Evaporation'], answer:1, explain:'Oxidative phosphorylation produces most ATP in mitochondria.'},
        {id:'10-6', q:'Which is an example of an exothermic reaction?', options:['Melting ice','Rusting iron','Combustion of petrol','Dissolving salt'], answer:2, explain:'Combustion releases heat (exothermic).'},
        {id:'10-7', q:'Which hormone regulates blood sugar by lowering it?', options:['Glucagon','Insulin','Adrenaline','Thyroxine'], answer:1, explain:'Insulin lowers blood glucose by helping uptake.'},
        {id:'10-8', q:'What kind of mirror forms a real image?', options:['Plane mirror','Convex mirror','Concave mirror','None'], answer:2, explain:'Concave mirrors can form real images when object is outside the focal length.'},
        {id:'10-9', q:'Which is basic unit for measuring luminous intensity?', options:['Candela','Kelvin','Lumens','Watt'], answer:0, explain:'Candela (cd) is SI base unit of luminous intensity.'},
        {id:'10-10', q:'Which process increases entropy in a system?', options:['Organized assembly','Spontaneous mixing','Crystallization','Freezing'], answer:1, explain:'Mixing increases disorder (entropy).'},
        {id:'10-11', q:'What is the function of ribosomes?', options:['Store energy','Protein synthesis','Photosynthesis','Transport'], answer:1, explain:'Ribosomes are sites of protein assembly.'},
        {id:'10-12', q:'Which is a diatomic molecule?', options:['Argon','Neon','Oxygen (O2)','Xenon'], answer:2, explain:'O₂ is diatomic (two atoms of oxygen).'},
        {id:'10-13', q:'Ohm\'s law relates which three quantities?', options:['Voltage, current, resistance','Voltage, power, energy','Mass, gravity, force','Wavelength, frequency, speed'], answer:0, explain:'Ohm’s law: V = I × R.'},
        {id:'10-14', q:'Which phenomenon is used in radio to send signals?', options:['Diffraction','Reflection','Electromagnetic wave propagation','Osmosis'], answer:2, explain:'Radio uses electromagnetic wave propagation.'},
        {id:'10-15', q:'Which organ regulates internal temperature in humans?', options:['Skin and hypothalamus','Liver only','Heart only','Kidney only'], answer:0, explain:'Hypothalamus and skin (sweating, blood flow) regulate body temperature.'},
        {id:'10-16', q:'Which process forms polymers from monomers?', options:['Hydrolysis','Polymerization','Combustion','Fission'], answer:1, explain:'Polymerization links monomers into polymers.'},
        {id:'10-17', q:'Which particle contributes most to atomic mass?', options:['Electron','Proton','Neutron','Photon'], answer:2, explain:'Neutrons and protons contribute to most mass; neutrons are neutral.'},
        {id:'10-18', q:'Which is the SI unit of pressure?', options:['Pascal','Newton','Joule','Watt'], answer:0, explain:'Pascal (Pa) is the SI unit of pressure.'},
        {id:'10-19', q:'Which wave property is measured in hertz (Hz)?', options:['Amplitude','Speed','Frequency','Wavelength'], answer:2, explain:'Frequency is measured in hertz (cycles per second).'},
        {id:'10-20', q:'Which process is central to Darwin\'s theory of evolution?', options:['Photosynthesis','Natural selection','Miracles','Alchemy'], answer:1, explain:'Natural selection drives evolution by survival of the fittest.'},
        {id:'10-21', q:'Which law relates pressure and volume of a gas at constant temperature?', options:['Boyle\'s law','Charles\' law','Ohm\'s law','Hooke\'s law'], answer:0, explain:'Boyle\'s law states pressure × volume = constant at fixed temperature.'},
    {id:'10-22', q:'Which process breaks down glucose for energy in cells?', options:['Photosynthesis','Cellular respiration','Polymerization','Sublimation'], answer:1, explain:'Cellular respiration converts glucose into ATP.'},
    {id:'10-23', q:'Which particle has a positive charge?', options:['Electron','Proton','Neutron','Photon'], answer:1, explain:'Protons carry positive charges.'},
    {id:'10-24', q:'Which reaction type involves electron transfer between species?', options:['Redox reaction','Neutralization','Precipitation','Polymerization'], answer:0, explain:'Redox reactions involve oxidation and reduction (electron transfer).'},
    {id:'10-25', q:'Which optical instrument uses lenses to make distant objects appear nearer?', options:['Microscope','Telescope','Spectrometer','Calorimeter'], answer:1, explain:'Telescopes use lenses or mirrors to view distant objects.'},
    {id:'10-26', q:'Which term describes the rate of change of velocity?', options:['Speed','Acceleration','Momentum','Force'], answer:1, explain:'Acceleration is change in velocity per time.'},
    {id:'10-27', q:'Which is the pH range of alkaline solutions?', options:['0-3','4-6','7','8-14'], answer:3, explain:'pH above 7 indicates alkaline (basic) solutions.'},
    {id:'10-28', q:'Which equation expresses Newton\'s second law?', options:['F = ma','E = mc^2','V = IR','pV = nRT'], answer:0, explain:'Newton\'s second law is Force equals mass times acceleration.'},
    {id:'10-29', q:'Which process in stars fuses hydrogen into helium releasing energy?', options:['Photosynthesis','Nuclear fusion','Radioactive decay','Combustion'], answer:1, explain:'Nuclear fusion powers stars by combining nuclei.'},
    {id:'10-30', q:'Which device converts alternating current (AC) to direct current (DC)?', options:['Transformer','Rectifier','Generator','Oscilloscope'], answer:1, explain:'Rectifiers convert AC into DC.'},
    {id:'10-31', q:'Which gas is primarily responsible for ocean acidification?', options:['Oxygen','Carbon dioxide','Nitrogen','Helium'], answer:1, explain:'CO₂ dissolves in seawater forming carbonic acid.'},
    {id:'10-32', q:'Which property of a wave is the distance between two crests?', options:['Amplitude','Wavelength','Frequency','Period'], answer:1, explain:'Wavelength is distance between successive crests.'},
    {id:'10-33', q:'Which separation technique uses a solvent and a stationary phase?', options:['Filtration','Chromatography','Distillation','Magnetism'], answer:1, explain:'Chromatography separates mixture components on phases.'},
    {id:'10-34', q:'Which effect explains photoelectric emission of electrons by light?', options:['Photoelectric effect','Doppler effect','Compton effect','Greenhouse effect'], answer:0, explain:'The photoelectric effect ejects electrons when light hits a surface.'},
    {id:'10-35', q:'Which is a strong acid commonly used in labs?', options:['Hydrochloric acid','Sodium chloride','Water','Ethanol'], answer:0, explain:'Hydrochloric acid (HCl) is a strong acid used in labs.'},
    {id:'10-36', q:'Which property determines the color of a solution in spectroscopy?', options:['Concentration only','Wavelength absorbed','pH only','Temperature only'], answer:1, explain:'Color depends on the wavelengths a substance absorbs/reflects.'},
    {id:'10-37', q:'Which nuclear particle determines isotope identity of an element?', options:['Electron','Proton','Neutron','Photon'], answer:2, explain:'Different numbers of neutrons create isotopes of the same element.'},
    {id:'10-38', q:'Which phenomenon causes apparent deflection of moving objects due to Earth\'s rotation?', options:['Coriolis effect','Centrifugal force','Gravity','Friction'], answer:0, explain:'The Coriolis effect deflects paths on a rotating body like Earth.'},
    {id:'10-39', q:'Which is the correct SI base unit for temperature?', options:['Celsius','Kelvin','Fahrenheit','Rankine'], answer:1, explain:'Kelvin (K) is the SI base unit for thermodynamic temperature.'},
    {id:'10-40', q:'Which reaction type produces an insoluble solid from aqueous solutions?', options:['Neutralization','Precipitation','Oxidation','Polymerization'], answer:1, explain:'Precipitation yields insoluble solids from solution.'},
    {id:'10-41', q:'Which mathematical relation defines pressure?', options:['Force × Area','Force / Area','Mass × Volume','Velocity × Time'], answer:1, explain:'Pressure = Force ÷ Area.'},
    {id:'10-42', q:'Which law relates pressure and temperature of a fixed mass of gas at constant volume?', options:['Boyle\'s law','Charles\' law','Gay-Lussac\'s law','Hooke\'s law'], answer:2, explain:'Gay-Lussac\'s law relates pressure and temperature at constant volume.'},
    {id:'10-43', q:'Which is a polymer formed from repeating monomers?', options:['Glucose','Cellulose','Water','Salt'], answer:1, explain:'Cellulose is a polymer of glucose units.'},
    {id:'10-44', q:'Which method is used to determine molecular mass by fragmentation of molecules?', options:['Chromatography','Mass spectrometry','Titration','Calorimetry'], answer:1, explain:'Mass spectrometry identifies mass/structure by fragments.'},
    {id:'10-45', q:'Which process in plants uses light to split water molecules?', options:['Photolysis during photosynthesis','Respiration','Transpiration','Germination'], answer:0, explain:'Photolysis splits water releasing electrons and O₂ in photosynthesis.'},
    {id:'10-46', q:'Which phenomenon describes light behaving as both wave and particle?', options:['Dual nature of light','Reflection','Refraction','Diffraction'], answer:0, explain:'Quantum theory shows light has both wave and particle properties.'},
    {id:'10-47', q:'Which technique separates isotopes due to mass differences?', options:['Chromatography','Mass spectrometry/centrifugation','Filtration','Distillation'], answer:1, explain:'Mass-based methods separate isotopes by mass difference.'},
    {id:'10-48', q:'Which kind of chemical bond produces a sea of electrons in metals?', options:['Covalent','Ionic','Metallic','Hydrogen'], answer:2, explain:'Metallic bonding has delocalized electrons forming metallic properties.'},
    {id:'10-49', q:'Which principle explains buoyant force on immersed objects?', options:['Archimedes\' principle','Bernoulli\'s principle','Pascal\'s principle','Hooke\'s law'], answer:0, explain:'Archimedes\' principle relates buoyant force to displaced fluid.'},
    {id:'10-50', q:'Which process converts atmospheric nitrogen into forms usable by plants?', options:['Nitrogen fixation','Photosynthesis','Respiration','Combustion'], answer:0, explain:'Nitrogen fixation by bacteria converts N₂ into nitrates/ammonia plants use.'},
    {id:'10-51', q:'What is activation energy?', options:['The energy released by a reaction','The minimum energy needed for a reaction to occur','Energy stored in bonds','Energy required to break a nucleus'], answer:1, explain:'Activation energy is the minimum energy required to start a chemical reaction.'},
{id:'10-52', q:'Which principle predicts how an equilibrium shifts when conditions change?', options:['Conservation of mass','Le Chatelier\'s principle','Boyle\'s law','Avogadro\'s law'], answer:1, explain:'Le Chatelier\'s principle describes how equilibrium responds to changes in concentration, pressure or temperature.'},
{id:'10-53', q:'Doping silicon with phosphorus produces which semiconductor type?', options:['p-type','n-type','Intrinsic','Insulator'], answer:1, explain:'Phosphorus adds extra electrons, creating an n-type semiconductor.'},
{id:'10-54', q:'A diode mainly allows current to flow in which direction?', options:['Both directions equally','From anode to cathode (forward)','Only when reverse biased','It blocks all current'], answer:1, explain:'A diode conducts easily in forward bias (anode→cathode) and blocks in reverse.'},
{id:'10-55', q:'What is electroplating?', options:['Using electricity to coat a metal surface with another metal','Melting metals','Mixing metal powders','Measuring electrical resistance'], answer:0, explain:'Electroplating deposits a thin metal layer onto a substrate using electrolysis.'},
{id:'10-56', q:'A buffer solution typically contains which components?', options:['Strong acid and strong base','A weak acid and its salt','Pure water and salt','Strong base and its salt'], answer:1, explain:'A buffer resists pH change and is usually a weak acid with its conjugate base (salt).'},

{id:'10-57', q:'Which equation is the ideal gas law?', options:['PV = nRT','P + V = nRT','PV = RT','P = V n R'], answer:0, explain:'The ideal gas law relates pressure, volume, amount (moles) and temperature: PV = nRT.'},
{id:'10-58', q:'Isotopes of the same element differ in the number of which particle?', options:['Protons','Electrons','Neutrons','Photons'], answer:2, explain:'Isotopes have the same number of protons but different numbers of neutrons.'},
{id:'10-59', q:'During a titration, the indicator\'s colour change marks the?', options:['Equivalence point','Endpoint','Neutral point','Buffer point'], answer:1, explain:'The indicator shows the endpoint (observed colour change)—ideally close to the equivalence point.'},
{id:'10-60', q:'What is the usual oxidation state of oxygen in compounds?', options:['+2','-2','0','+1'], answer:1, explain:'Oxygen is commonly −2 in most compounds.'},
{id:'10-61', q:'Approximate speed of light in vacuum?', options:['3 × 10^6 m/s','3 × 10^7 m/s','3 × 10^8 m/s','3 × 10^5 m/s'], answer:2, explain:'The speed of light is roughly 3 × 10^8 metres per second.'},
{id:'10-62', q:'Which device converts stored chemical energy into electrical energy?', options:['Electric motor','Battery','Generator','Transformer'], answer:1, explain:'Batteries convert chemical energy to electrical energy.'},

{id:'10-63', q:'Arrange these electromagnetic waves from low to high frequency.', options:['Radio, Microwave, Infrared, Visible','Visible, Infrared, Microwave, Radio','X-ray, Gamma, Ultraviolet, Visible','Microwave, Radio, Visible, Infrared'], answer:0, explain:'Radio → microwave → infrared → visible is increasing frequency order.'},
{id:'10-64', q:'Half-life of a radioactive isotope is the time for?', options:['Complete decay','Half the original nuclei to decay','Doubling of nuclei','One atom to decay'], answer:1, explain:'Half-life is the time required for half the radioactive nuclei to decay.'},
{id:'10-65', q:'Which apparatus dispenses measured volumes during titration?', options:['Pipette','Burette','Beaker','Conical flask'], answer:1, explain:'A burette accurately delivers titrant volume during titration.'},
{id:'10-66', q:'Neutralization of an acid with a base typically produces?', options:['Salt and water','Gas only','Heat only','Precipitate and gas'], answer:0, explain:'An acid + base reaction commonly yields a salt and water.'},
{id:'10-67', q:'Enzymes are biological what?', options:['Carbohydrates','Catalysts','Acids','Salts'], answer:1, explain:'Enzymes are biological catalysts that speed up biochemical reactions.'},
{id:'10-68', q:'DNA backbone is made of which components?', options:['Amino acids','Fatty acids','Sugar and phosphate','Nucleases'], answer:2, explain:'DNA backbone is a repeating sugar–phosphate chain.'},

{id:'10-69', q:'Mendel\'s law of segregation states that during gamete formation...', options:['Genes blend','Alleles separate into different gametes','Traits are acquired','Dominant traits always disappear'], answer:1, explain:'Alleles separate so each gamete gets one allele of a gene.'},
{id:'10-70', q:'Which level in an ecological pyramid contains the most energy?', options:['Producers','Primary consumers','Secondary consumers','Tertiary consumers'], answer:0, explain:'Producers (plants) form the base with the highest available energy.'},
{id:'10-71', q:'An electromagnet generates a magnetic field when there is?', options:['Low temperature','Electric current in a coil','High pressure','Sunlight'], answer:1, explain:'Current through a coil produces a magnetic field, forming an electromagnet.'},
{id:'10-72', q:'The lens formula is written as:', options:['1/f = 1/u + 1/v','f = u + v','uv = f','u + v = f'], answer:0, explain:'The lens formula relates focal length f, object distance u and image distance v.'},
{id:'10-73', q:'When light enters a denser medium, its speed?', options:['Speeds up','Slows down','Stops','Does not change'], answer:1, explain:'Light slows down when passing into a denser optical medium.'},
{id:'10-74', q:'Which catalyst is commonly used in the Haber process to make ammonia?', options:['Platinum','Iron','Copper','Nickel'], answer:1, explain:'Iron catalysts help synthesize ammonia from N₂ and H₂.'},

{id:'10-75', q:'Which gas is commonly used as an inert shielding gas in welding?', options:['Oxygen','Argon','Chlorine','Nitrogen'], answer:1, explain:'Argon is an inert gas widely used to shield welds from air.'},
{id:'10-76', q:'An analytical balance is used to measure?', options:['Temperature','Very small mass precisely','Electric current','Volume'], answer:1, explain:'Analytical balances give very precise mass measurements.'},
{id:'10-77', q:'Beta radiation usually consists of which particle?', options:['Alpha particles','Electrons/positrons','Neutrons','Photons'], answer:1, explain:'Beta radiation consists of high-speed electrons or positrons.'},
{id:'10-78', q:'Bronze is an alloy of which two elements?', options:['Iron and carbon','Copper and tin','Aluminium and magnesium','Copper and nickel'], answer:1, explain:'Bronze is primarily copper with tin added.'},
{id:'10-79', q:'Deficiency of which vitamin causes scurvy?', options:['Vitamin A','Vitamin B12','Vitamin C','Vitamin D'], answer:2, explain:'A lack of vitamin C leads to scurvy.'},
{id:'10-80', q:'Carbon monoxide is especially dangerous because it...', options:['Smells bad','Binds to hemoglobin and prevents oxygen transport','Makes water acidic','Causes rust'], answer:1, explain:'CO binds to hemoglobin more strongly than O₂, reducing oxygen delivery.'},

{id:'10-81', q:'An autoclave sterilizes instruments using?', options:['Dry heat at high temperature','Chemical disinfectants','Steam under pressure','UV light'], answer:2, explain:'Autoclaves use pressurised steam to sterilize equipment.'},
{id:'10-82', q:'Peptide bonds join which building blocks?', options:['Sugars','Amino acids','Nucleotides','Fatty acids'], answer:1, explain:'Peptide bonds link amino acids into proteins.'},
{id:'10-83', q:'The SI unit of capacitance is the?', options:['Ohm','Farad','Henry','Siemens'], answer:1, explain:'Capacitance is measured in farads (F).'},
{id:'10-84', q:'Smelting extracts metal from ore by using?', options:['Water','Heat and a reducing agent','Electricity only','Magnetic separation'], answer:1, explain:'Smelting uses heat (and often carbon) to reduce metal oxides to metal.'},
{id:'10-85', q:'Atomic number of an element equals the number of?', options:['Neutrons','Electrons in a neutral atom','Protons','Nucleons'], answer:2, explain:'Atomic number is defined by the number of protons.'},
{id:'10-86', q:'Which instrument displays time-varying voltages and frequency visually?', options:['Voltmeter','Oscilloscope','Ammeter','Multimeter'], answer:1, explain:'An oscilloscope shows electrical signals as waveforms.'},

{id:'10-87', q:'Which gas fills incandescent bulbs to reduce filament oxidation?', options:['Oxygen','Argon','Hydrogen','Nitrogen'], answer:1, explain:'Inert gases like argon protect the hot filament from oxidising.'},
{id:'10-88', q:'Latent heat of vaporization is energy required to change from?', options:['Solid to liquid','Liquid to gas','Gas to plasma','Liquid to solid'], answer:1, explain:'Latent heat of vaporization converts liquid into vapor without temperature change.'},
{id:'10-89', q:'Diffraction effects are most noticeable when the obstacle size is?', options:['Much larger than wavelength','Much smaller than wavelength','Comparable to the wavelength','Irrelevant to wavelength'], answer:2, explain:'Diffraction is prominent when obstacle size is similar to the wavelength.'},
{id:'10-90', q:'To neutralize a small acid spill safely, a common household neutraliser is?', options:['Hydrochloric acid','Sodium hydroxide','Sodium bicarbonate (baking soda)','Sulfuric acid'], answer:2, explain:'Baking soda (sodium bicarbonate) neutralizes weak acid spills safely.'},
{id:'10-91', q:'The principal component of natural gas is?', options:['Ethane','Propane','Methane','Butane'], answer:2, explain:'Methane is the main component of natural gas.'},
{id:'10-92', q:'By mass, which element is most abundant in the Earth\'s crust?', options:['Iron','Oxygen','Silicon','Aluminium'], answer:1, explain:'Oxygen is the most abundant element in the Earth\'s crust by mass.'},

{id:'10-93', q:'Phenolphthalein turns what colour in basic solutions?', options:['Colourless','Pink','Blue','Green'], answer:1, explain:'Phenolphthalein is colourless in acid and pink in basic solutions.'},
{id:'10-94', q:'The Richter scale measures?', options:['Temperature','Earthquake magnitude','Sound intensity','Wind speed'], answer:1, explain:'Richter (or related scales) quantify earthquake magnitude.'},
{id:'10-95', q:'Which instrument is used to measure pH?', options:['Hydrometer','pH meter','Barometer','Hygrometer'], answer:1, explain:'A pH meter measures the acidity/alkalinity of a solution.'},
{id:'10-96', q:'Hooke\'s law for springs relates force to which quantity?', options:['Mass','Extension','Temperature','Pressure'], answer:1, explain:'Hooke\'s law: F = kx, force is proportional to extension x.'},
{id:'10-97', q:'Pascal\'s principle (pressure transmitted equally) is used in which device?', options:['Lever','Hydraulic press','Pulley','Spring'], answer:1, explain:'Hydraulic presses use Pascal\'s principle to multiply force.'},
{id:'10-98', q:'Electric potential difference (voltage) is energy per unit of what?', options:['Charge','Mass','Distance','Time'], answer:0, explain:'Voltage is energy per unit charge (joules per coulomb).'},

{id:'10-99', q:'Which metal has the highest electrical conductivity at room temperature?', options:['Copper','Aluminium','Gold','Silver'], answer:3, explain:'Silver has the highest electrical conductivity of all metals.'},
{id:'10-100', q:'Which spectroscopy technique is mainly used to identify functional groups by vibration?', options:['NMR','IR spectroscopy','Mass spectrometry','UV-Vis spectroscopy'], answer:1, explain:'IR spectroscopy identifies molecular functional groups by their vibrational absorptions.'}
    ]
    };

    /* ====== Utility keys & small helpers ====== */
    const TOTAL_PER_QUIZ = 20;

    function lastScoreKeyForClass(cls){
      return `brainrootx_science_lastscore_class${cls}`;
    }

    // quiz state
    let quizState = {
      cls: null,
      questions: [],
      answers: [],   // selected indices or null
      current: 0
    };

    // DOM refs
    const openScienceQuizBtn = document.getElementById('openScienceQuiz');
    const openLearnScienceBtn = document.getElementById('openLearnScience');
    const classGrid = document.getElementById('scienceClassGrid');
    const quizTitle = document.getElementById('scienceQuizTitle');
    const qArea = document.getElementById('scienceQuestionArea');
    const prevBtn = document.getElementById('sciencePrevBtn');
    const nextBtn = document.getElementById('scienceNextBtn');
    const submitBtn = document.getElementById('scienceSubmitBtn');
    const pbBar = document.getElementById('scienceProgressBar');
    const pbText = document.getElementById('scienceProgressText');

    const resultsSummary = document.getElementById('scienceResultsSummary');
    const reviewList = document.getElementById('scienceReviewList');

    // ------------- Build class buttons -------------
    function buildClassButtons(){
      if(!classGrid) return;
      classGrid.innerHTML = '';
      for(let c=3;c<=10;c++){
        const btn = document.createElement('button');
        btn.className = 'btn btn-ghost';
        btn.textContent = `Class ${c}`;
        btn.dataset.cls = String(c);
        btn.addEventListener('click', ()=> {
          playSfx('nav');
          startClassQuiz(String(c));
        });
        classGrid.appendChild(btn);
      }
    }

    // ------------- Start quiz for a class -------------
    function startClassQuiz(cls){
      const bank = scienceQuestions[String(cls)];
      if(!bank || !Array.isArray(bank) || bank.length < TOTAL_PER_QUIZ){
        alert(`Questions for Class ${cls} are not available yet.`);
        return;
      }

      // Shuffle copy to avoid modifying original; take exactly TOTAL_PER_QUIZ (banks already 20)
      const qCopy = shuffle([...bank]).slice(0, TOTAL_PER_QUIZ);
      quizState = {
        cls: cls,
        questions: qCopy,
        answers: Array(qCopy.length).fill(null),
        current: 0
      };

      // update UI
      quizTitle.textContent = `Science Quiz — Class ${cls}`;
      updateProgress();
      renderQuestion(0);
      showScreen('scienceQuiz');
      playSfx('nav');
    }

    // ------------- render question -------------
    function renderQuestion(index){
      if(!qArea || !quizState.questions || index < 0 || index >= quizState.questions.length) return;
      quizState.current = index;

      const qObj = quizState.questions[index];
      const sel = quizState.answers[index];

      // Build HTML
      let html = '';
      html += `<div class="question-num tiny muted">Question ${index+1} of ${quizState.questions.length}</div>`;
      html += `<div class="qb-question">${escapeHtml(qObj.q)}</div>`;
      html += `<div class="qb-options">`;
      qObj.options.forEach((opt, i) => {
        const selectedClass = (sel === i) ? 'selected' : '';
        html += `<button class="qb-option ${selectedClass}" data-opt="${i}" type="button">${escapeHtml(opt)}</button>`;
      });
      html += `</div>`;

      qArea.innerHTML = html;

      // attach option handlers
      const optionEls = qArea.querySelectorAll('.qb-option');
      optionEls.forEach(btn=>{
        btn.addEventListener('click', (ev)=>{
          const idx = Number(btn.getAttribute('data-opt'));
          quizState.answers[index] = idx;
          // update visuals
          optionEls.forEach(b=>b.classList.remove('selected'));
          btn.classList.add('selected');
          playSfx('pop');
        });
      });

      // update prev/next button states
      prevBtn.disabled = (index === 0);
      nextBtn.disabled = (index === quizState.questions.length - 1);
      updateProgress();
      // focus first option for a11y
      try { optionEls[0] && optionEls[0].focus(); } catch(e){}
    }

    // ------------- navigation handlers -------------
    prevBtn?.addEventListener('click', ()=>{
      if(quizState.current > 0){ renderQuestion(quizState.current - 1); playSfx('nav'); }
    });
    nextBtn?.addEventListener('click', ()=>{
      if(quizState.current < quizState.questions.length - 1){ renderQuestion(quizState.current + 1); playSfx('nav'); }
    });

    // Submit
    submitBtn?.addEventListener('click', ()=> confirmAndSubmit());

    function updateProgress(){
      const total = quizState.questions.length || TOTAL_PER_QUIZ;
      const cur = (quizState.current || 0) + 1;
      const percent = Math.round((cur / total) * 100);
      if(pbBar) pbBar.style.width = `${percent}%`;
      if(pbText) pbText.textContent = `${cur} / ${total}`;
    }

    // ------------- Submit & results -------------
    function confirmAndSubmit(){
      // simple confirm
      const answeredCount = quizState.answers.filter(a => a !== null).length;
      const total = quizState.questions.length;
      if(!confirm(`Submit quiz? You answered ${answeredCount} of ${total} questions.`)) return;
      // compute
      computeResults();
    }

    function computeResults(){
      const total = quizState.questions.length;
      let right = 0, wrong = 0, unattempted = 0;
      quizState.questions.forEach((q,i)=>{
        const sel = quizState.answers[i];
        if(sel === null || typeof sel === 'undefined'){ unattempted++; }
        else if(sel === q.answer) right++;
        else wrong++;
      });

      const percent = Math.round((right / total) * 100);
      const overallScore = percent; // simple percent-based score
      // derive an IQ-like score for fun: range 70..130 mapped from percent 0..100
      const IQ = 70 + Math.round((percent / 100) * 60);

      // improvement vs last
      const key = lastScoreKeyForClass(quizState.cls);
      const prevRaw = localStorage.getItem(key);
      const prev = prevRaw ? Number(prevRaw) : null;
      const improvement = (prev === null) ? null : Math.round(percent - prev);

      // save new last score
      try { localStorage.setItem(key, String(percent)); } catch(e){}

      // show results UI
      showResults({ total, right, wrong, unattempted, percent, overallScore, IQ, prev, improvement });
      // play sound based on performance
      if(percent >= 80){ playSfx('levelUp'); } 
      else if (percent >= 50){ playSfx('cheer'); }
      else { playSfx('wrong'); }
    }

    function showResults(stats){
      // summary
      resultsSummary.innerHTML = `
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <div class="science-stat">
            <div class="num">${stats.percent}%</div>
            <div class="lbl">Score (%)</div>
          </div>
          <div class="science-stat">
            <div class="num">${stats.overallScore}</div>
            <div class="lbl">Overall score</div>
          </div>
          <div class="science-stat">
            <div class="num">${stats.IQ}</div>
            <div class="lbl">IQ estimate</div>
          </div>
          <div class="science-stat">
            <div class="num">${stats.right}</div>
            <div class="lbl">Correct</div>
          </div>
          <div class="science-stat">
            <div class="num">${stats.wrong}</div>
            <div class="lbl">Wrong</div>
          </div>
          <div class="science-stat">
            <div class="num">${stats.unattempted}</div>
            <div class="lbl">Unanswered</div>
          </div>
          <div class="science-stat">
            <div class="num">${stats.prev === null ? '—' : stats.prev + '%'}</div>
            <div class="lbl">Last attempt</div>
          </div>
          <div class="science-stat">
            <div class="num">${stats.improvement === null ? '—' : (stats.improvement > 0 ? '+' : '') + stats.improvement + '%'}</div>
            <div class="lbl">Improvement</div>
          </div>
        </div>
      `;

      // review list
      reviewList.innerHTML = '';
      quizState.questions.forEach((q, i)=>{
        const sel = quizState.answers[i];
        const userText = (sel === null || typeof sel === 'undefined') ? 'No answer' : q.options[sel];
        const correctText = q.options[q.answer];
        const isCorrect = (sel === q.answer);
        const item = document.createElement('div');
        item.className = 'item';
        item.innerHTML = `
          <div class="qtxt">${i+1}. ${escapeHtml(q.q)}</div>
          <div class="ans">Your answer: <strong>${escapeHtml(String(userText))}</strong> ${isCorrect ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--red)">✕</span>'}</div>
          <div class="ans">Correct: <strong>${escapeHtml(correctText)}</strong></div>
          <div class="muted" style="margin-top:6px">${escapeHtml(q.explain || '')}</div>
        `;
        reviewList.appendChild(item);
      });

      // wire result buttons
      document.getElementById('scienceRetakeBtn')?.addEventListener('click', ()=>{
        playSfx('nav');
        startClassQuiz(quizState.cls);
      });
      document.getElementById('scienceToClassesBtn')?.addEventListener('click', ()=>{
        playSfx('nav');
        showScreen('scienceClassSelect');
      });
      document.getElementById('scienceToMenuBtn')?.addEventListener('click', ()=>{
        playSfx('nav');
        showScreen('menu');
      });

      showScreen('scienceResults');
    }

    // ------------- wiring for nav buttons -------------
    openScienceQuizBtn?.addEventListener('click', ()=>{
      playSfx('nav');
      buildClassButtons();
      showScreen('scienceClassSelect');
    });

    openLearnScienceBtn?.addEventListener('click', ()=>{
      playSfx('nav');
      showScreen('learnScience');
    });

    // Back to classes
    document.getElementById('scienceBackToClasses')?.addEventListener('click', ()=>{
      playSfx('nav');
      buildClassButtons();
      showScreen('scienceClassSelect');
    });

    // Back from results
    document.getElementById('scienceResultsBack')?.addEventListener('click', ()=>{
      playSfx('nav');
      showScreen('scienceQuiz');
    });

    // Ensure menu-btns with data-target navigate properly (your generic handler probably exists)
    // but add a small fallback:
    document.querySelectorAll('#science .menu-btn, #learnScience .menu-btn').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{
        const target = btn.getAttribute('data-target') || 'menu';
        showScreen(target);
      });
    });

    // initial build
    buildClassButtons();

    // expose some debugging hooks (optional)
    window._BRX_science = {
      startClassQuiz,
      scienceQuestions,
      getQuizState: ()=> quizState
    };

  }); // DOMContentLoaded end
})();

/* ========== GK ========= */
const GK_POOL = buildGkPool();
$('#startGK')?.addEventListener('click', ()=>{
  playSfx('click');
  const idxs = shuffle([...Array(GK_POOL.length).keys()]).slice(0,10);
  const subset = idxs.map(i=>GK_POOL[i]);
  renderQuiz($('#gkQuiz'), subset, {announce:true});
});

function buildGkPool(){
  const capitals = [
    ["India","New Delhi"],["USA","Washington, D.C."],["UK","London"],["France","Paris"],["Germany","Berlin"],
    ["Italy","Rome"],["Spain","Madrid"],["Portugal","Lisbon"],["China","Beijing"],["Japan","Tokyo"],
    ["South Korea","Seoul"],["Russia","Moscow"],["Canada","Ottawa"],["Australia","Canberra"],["New Zealand","Wellington"],
    ["Brazil","Brasília"],["Argentina","Buenos Aires"],["Mexico","Mexico City"],["Egypt","Cairo"],["South Africa","Pretoria"],
    ["Nigeria","Abuja"],["Kenya","Nairobi"],["Saudi Arabia","Riyadh"],["UAE","Abu Dhabi"],["Turkey","Ankara"],
    ["Greece","Athens"],["Netherlands","Amsterdam"],["Sweden","Stockholm"],["Norway","Oslo"],["Denmark","Copenhagen"],
    ["Finland","Helsinki"],["Poland","Warsaw"],["Switzerland","Bern"],["Austria","Vienna"],["Belgium","Brussels"],
    ["Thailand","Bangkok"],["Vietnam","Hanoi"],["Indonesia","Jakarta"],["Philippines","Manila"],["Singapore","Singapore"]
  ];
  const capitalOptions = capitals.map(([,c])=>c);

  const science = [
    ["Which planet is known as the Red Planet?", ["Venus","Mars","Jupiter","Mercury"], 1],
    ["What gas do plants absorb from air?", ["Oxygen","Nitrogen","Carbon dioxide","Helium"], 2],
    ["H2O is the chemical formula of?", ["Salt","Water","Hydrogen","Ozone"], 1],
    ["Who proposed the theory of relativity?", ["Newton","Einstein","Tesla","Edison"], 1],
    ["What part of the plant conducts photosynthesis?", ["Root","Stem","Leaf","Flower"], 2],
    ["Which metal is liquid at room temp?", ["Iron","Mercury","Aluminium","Copper"], 1],
    ["What force pulls objects to Earth?", ["Magnetism","Gravity","Friction","Tension"], 1],
    ["What gas do humans exhale mostly?", ["O2","CO2","N2","H2"], 1],
    ["Earth’s natural satellite is?", ["Phobos","Europa","Moon","Titan"], 2],
    ["Human heart pumps what?", ["Air","Water","Blood","Food"], 2],
  ];

  const misc = [
    ["Who is known as the Father of Computers?", ["Charles Babbage","Alan Turing","Bill Gates","Tim Berners-Lee"], 0],
    ["Which is the largest ocean?", ["Atlantic","Indian","Pacific","Arctic"], 2],
    ["Which is the tallest mountain?", ["K2","Everest","Kangchenjunga","Makalu"], 1],
    ["Which festival is the Festival of Lights in India?", ["Holi","Navratri","Diwali","Onam"], 2],
    ["How many continents are there?", ["5","6","7","8"], 2],
    ["Which is the largest mammal?", ["Elephant","Blue whale","Giraffe","Hippopotamus"], 1],
    ["Which device measures temperature?", ["Barometer","Thermometer","Ammeter","Voltmeter"], 1],
    ["Which is the smallest prime number?", ["0","1","2","3"], 2],
    ["Primary colors of light include:", ["Red, Green, Blue","Red, Yellow, Blue","Cyan, Magenta, Yellow","Red, Green, Yellow"], 0],
    ["Who wrote 'Hamlet'?", ["Charles Dickens","Leo Tolstoy","William Shakespeare","Mark Twain"], 2],
  ];

  const capQs = capitals.map(([country, capital])=>{
    const wrongs = shuffle(capitalOptions.filter(c=>c!==capital)).slice(0,3);
    const choices = shuffle([capital, ...wrongs]);
    return { q: `What is the capital of ${country}?`, choices, correctAnswer: capital };
  });

  function expand(list, target){
    const out=[];
    let i=0;
    while(out.length<target){
      const base = list[i % list.length];
      const choices = shuffle(base[1].slice());
      const correctText = base[1][base[2]];
      out.push({ q: base[0], choices, correctAnswer: String(correctText) });
      i++;
    }
    return out;
  }

  const pool = [...capQs, ...expand(science,30), ...expand(misc,30)];
  return pool.slice(0,100);
}
/* ========== LEADERBOARD ========= */
async function renderLeaderboard(){
  const wrap = $('#leaderWrap');
  if(!wrap) return;
  wrap.innerHTML = `<p class="muted">Loading leaderboard…</p>`;

  // try cloud first (best effort)
  let rows = [];
  if(state.firebase.db){
    try{
      const {collection, getDocs, query, orderBy, limit} = state.firebase._mods.dbMod;
      const q = query(collection(state.firebase.db,'leaderboard'), orderBy('streak','desc'), limit(50));
      const snap = await getDocs(q);
      rows = snap.docs.map(d=>{ const data = d.data()||{}; data._displayStreak = (data.lastStreakDate && (new Date(data.lastStreakDate) < (new Date(new Date().setDate(new Date().getDate()-1)))) ) ? 0 : (data.streak||0); return data; });
    }catch(e){ console.warn("leaderboard cloud error", e); }
  }

  if(!rows.length){
    rows = [
      {username:"Aarav", streak:12},
      {username:"Zoya", streak:9},
      {username:"Kabir", streak:7},
      {username:"Mia", streak:4},
      {username:"Ishaan", streak:3},
    ];
  }

  // ensure current user is present and up-to-date
  const myName = (state.user?.name && String(state.user.name).trim()) || "You";
  let meIdx = rows.findIndex(r => (r.username||"") === myName);
  if(meIdx < 0){
    rows.push({ username: myName, streak: state.streakDays||0 });
  } else {
    rows[meIdx].streak = state.streakDays||0; // refresh my streak
  }

  // stable sort
  rows.sort((a,b)=> (b.streak||0) - (a.streak||0));

  wrap.innerHTML = rows.map((r,i)=>{
    const medal = i===0?"🥇":i===1?"🥈":i===2?"🥉":"";
    const top = i<3 ? "top" : "";
    return `<div class="row ${top}">
      <div>${medal?`<span class="medal">${medal}</span>`:""} <b>${escapeHtml(r.username||"User")}</b></div>
      <div>${r.streak||0} days</div>
    </div>`;
  }).join("");
}
document.querySelector('[data-target="leaderboard"]')?.addEventListener('click', renderLeaderboard);
/* ========== SPEAKING COACH ========= */
const speakLessons = [
  "Good morning. How are you today?",
  "My name is ____. I am learning English every day.",
  "I like reading stories and playing football.",
  "Could you please repeat that more slowly?",
  "I will practice speaking for fifteen minutes daily.",
  "Can you help me with this homework?",
  "I have a younger brother and an elder sister.",
  "I want to drink a glass of water.",
  "Please open the window, it is hot.",
  "Where is the nearest bus stop?",
  "I am hungry, let’s eat some food.",
  "I wake up early every morning.",
  "Do you like to play cricket?",
  "We are going to the park this evening.",
  "This is my best friend.",
  "I am reading an interesting book.",
  "The teacher is very kind and helpful.",
  "I want to become a good speaker.",
  "Please give me a pen and notebook.",
  "Where do you live?",
  "I like to listen to music.",
  "We are watching a movie tonight.",
  "She is my classmate and neighbor.",
  "I am learning something new every day.",
  "Can you tell me the time?",
  "I am going to visit my grandparents tomorrow.",
  "It is raining outside.",
  "Please close the door quietly.",
  "I like to eat fruits and vegetables.",
  "This room is very clean and big.",
  "I enjoy playing with my friends.",
  "The train station is very far from here.",
  "I want to buy a new bag.",
  "She is drawing a beautiful picture.",
  "We are studying for the exam.",
  "I always say thank you and please.",
  "The sun sets in the west.",
  "My father works in an office.",
  "The baby is crying loudly.",
  "I am wearing a blue shirt.",
  "The dog is barking outside.",
  "I like to drink orange juice.",
  "We should wash our hands before eating.",
  "The teacher is writing on the blackboard.",
  "There are many books in the library.",
  "He is playing with a ball.",
  "The flowers are very colorful.",
  "We are going on a picnic tomorrow.",
  "I want to become a doctor.",
  "My mother is cooking food in the kitchen.",
  "It is very cold in winter.",
  "Birds are flying in the sky.",
  "I can see the moon at night.",
  "She is reading a story book.",
  "I want to go shopping with my mother.",
  "We are watching television together.",
  "The bus is very crowded today.",
  "Please switch off the fan.",
  "My birthday is in March.",
  "We are playing hide and seek.",
  "The shop is near my house.",
  "I drink milk every night.",
  "We are celebrating Independence Day.",
  "He is brushing his teeth.",
  "My uncle lives in Delhi.",
  "The train is very fast.",
  "The stars twinkle at night.",
  "I like to swim in the pool.",
  "This is my new bicycle.",
  "I am going to the market.",
  "The cow gives us milk.",
  "My school is very big.",
  "We are planting trees in the garden.",
  "She is wearing a red dress.",
  "The bird is sitting on the tree.",
  "I like to play with toys.",
  "The baby is sleeping in the cradle.",
  "My shoes are under the bed.",
  "Do you know how to ride a bicycle?",
  "The sun rises in the east.",
  "I drink tea every morning.",
  "She is writing a letter to her friend.",
  "We are playing in the garden.",
  "I saw a rainbow yesterday.",
  "Can you lend me some money?",
  "The stars shine at night.",
  "I am brushing my teeth.",
  "They are going to school by bus.",
  "I like to draw pictures.",
  "We are planting trees on Sunday.",
  "She is wearing a red dress.",
  "I hear birds singing in the morning.",
  "The clock is on the wall.",
  "He is watering the plants.",
  "Please wash your hands before eating.",
  "I am sitting on a chair.",
  "The cow gives us milk.",
  // 🔹 Extra 10 sentences
  "My grandfather tells me stories at night.",
  "The festival brings joy to everyone.",
  "We should always speak the truth.",
  "She sings songs very well.",
  "I keep my room clean and tidy.",
  "The bus driver is very friendly.",
  "Our class teacher teaches us English.",
  "I drink plenty of water every day.",
  "The dog loves to play with a ball.",
  "We clap when the performance is good."
];

// 🔹 Hindi Translations
const TRANSLATIONS = {
  "Good morning. How are you today?": "सुप्रभात। आज आप कैसे हैं?",
  "My name is ____. I am learning English every day.": "मेरा नाम ____ है। मैं रोज़ अंग्रेज़ी सीख रहा हूँ।",
  "I like reading stories and playing football.": "मुझे कहानियाँ पढ़ना और फुटबॉल खेलना पसंद है।",
  "Could you please repeat that more slowly?": "क्या आप कृपया उसे थोड़ा धीरे दोहरा सकते हैं?",
  "I will practice speaking for fifteen minutes daily.": "मैं रोज़ पंद्रह मिनट बोलने का अभ्यास करूँगा।","Can you help me with this homework?": "क्या आप मेरी इस गृहकार्य में मदद कर सकते हैं?",
  "I have a younger brother and an elder sister.": "मेरा एक छोटा भाई और एक बड़ी बहन है।",
  "I want to drink a glass of water.": "मैं एक गिलास पानी पीना चाहता हूँ।",
  "Please open the window, it is hot.": "कृपया खिड़की खोलें, बहुत गर्मी है।",
  "Where is the nearest bus stop?": "सबसे नज़दीकी बस स्टॉप कहाँ है?",
  "I am hungry, let’s eat some food.": "मुझे भूख लगी है, चलो कुछ खाना खाते हैं।",
  "I wake up early every morning.": "मैं रोज़ सुबह जल्दी उठता हूँ।",
  "Do you like to play cricket?": "क्या आपको क्रिकेट खेलना पसंद है?",
  "We are going to the park this evening.": "हम आज शाम पार्क जा रहे हैं।",
  "This is my best friend.": "यह मेरा सबसे अच्छा दोस्त है।",
  "I am reading an interesting book.": "मैं एक रोचक किताब पढ़ रहा हूँ।",
  "The teacher is very kind and helpful.": "शिक्षक बहुत दयालु और मददगार हैं।",
  "I want to become a good speaker.": "मैं एक अच्छा वक्ता बनना चाहता हूँ।",
  "Please give me a pen and notebook.": "कृपया मुझे एक पेन और नोटबुक दें।",
  "Where do you live?": "आप कहाँ रहते हैं?",
  "I like to listen to music.": "मुझे संगीत सुनना पसंद है।",
  "We are watching a movie tonight.": "हम आज रात एक फ़िल्म देख रहे हैं।",
  "She is my classmate and neighbor.": "वह मेरी सहपाठी और पड़ोसी है।",
  "I am learning something new every day.": "मैं रोज़ कुछ नया सीख रहा हूँ।",
  "Can you tell me the time?": "क्या आप मुझे समय बता सकते हैं?",
  "I am going to visit my grandparents tomorrow.": "मैं कल अपने दादा-दादी से मिलने जा रहा हूँ।",
  "It is raining outside.": "बाहर बारिश हो रही है।",
  "Please close the door quietly.": "कृपया दरवाज़ा धीरे से बंद करें।",
  "I like to eat fruits and vegetables.": "मुझे फल और सब्जियाँ खाना पसंद है।",
  "This room is very clean and big.": "यह कमरा बहुत साफ और बड़ा है।",
  "I enjoy playing with my friends.": "मुझे अपने दोस्तों के साथ खेलना पसंद है।",
  "The train station is very far from here.": "रेलवे स्टेशन यहाँ से बहुत दूर है।",
  "I want to buy a new bag.": "मैं एक नया बैग खरीदना चाहता हूँ।",
  "She is drawing a beautiful picture.": "वह एक सुंदर चित्र बना रही है।",
  "We are studying for the exam.": "हम परीक्षा की तैयारी कर रहे हैं।",
  "I always say thank you and please.": "मैं हमेशा धन्यवाद और कृपया कहता हूँ।",
  "The sun sets in the west.": "सूरज पश्चिम में डूबता है।",
  "My father works in an office.": "मेरे पिता एक दफ़्तर में काम करते हैं।",
  "The baby is crying loudly.": "बच्चा ज़ोर से रो रहा है।",
  "I am wearing a blue shirt.": "मैं नीली शर्ट पहन रहा हूँ।",
  "The dog is barking outside.": "कुत्ता बाहर भौंक रहा है।",
  "I like to drink orange juice.": "मुझे संतरे का जूस पीना पसंद है।",
  "We should wash our hands before eating.": "हमें खाने से पहले अपने हाथ धोने चाहिए।",
  "The teacher is writing on the blackboard.": "शिक्षक ब्लैकबोर्ड पर लिख रहे हैं।",
  "There are many books in the library.": "लाइब्रेरी में बहुत सारी किताबें हैं।",
  "He is playing with a ball.": "वह गेंद से खेल रहा है।",
  "The flowers are very colorful.": "फूल बहुत रंग-बिरंगे हैं।",
  "We are going on a picnic tomorrow.": "हम कल पिकनिक पर जा रहे हैं।",
  "I want to become a doctor.": "मैं डॉक्टर बनना चाहता हूँ।",
  "My mother is cooking food in the kitchen.": "मेरी माँ रसोई में खाना बना रही हैं।",
  "It is very cold in winter.": "सर्दियों में बहुत ठंड होती है।",
  "Birds are flying in the sky.": "पक्षी आसमान में उड़ रहे हैं।",
  "I can see the moon at night.": "मैं रात को चाँद देख सकता हूँ।",
  "She is reading a story book.": "वह कहानी की किताब पढ़ रही है।",
  "I want to go shopping with my mother.": "मैं अपनी माँ के साथ ख़रीदारी करना चाहता हूँ।",
  "We are watching television together.": "हम साथ में टेलीविज़न देख रहे हैं।",
  "The bus is very crowded today.": "आज बस बहुत भीड़भरी है।",
  "Please switch off the fan.": "कृपया पंखा बंद करें।",
  "My birthday is in March.": "मेरा जन्मदिन मार्च में है।",
  "We are playing hide and seek.": "हम आँख-मिचौली खेल रहे हैं।",
  "The shop is near my house.": "दुकान मेरे घर के पास है।",
  "I drink milk every night.": "मैं हर रात दूध पीता हूँ।",
  "We are celebrating Independence Day.": "हम स्वतंत्रता दिवस मना रहे हैं।",
  "He is brushing his teeth.": "वह अपने दाँत ब्रश कर रहा है।",
  "My uncle lives in Delhi.": "मेरे चाचा दिल्ली में रहते हैं।",
  "The train is very fast.": "ट्रेन बहुत तेज़ है।",
  "The stars twinkle at night.": "सितारे रात को टिमटिमाते हैं।",
  "I like to swim in the pool.": "मुझे तालाब में तैरना पसंद है।",
  "This is my new bicycle.": "यह मेरी नई साइकिल है।",
  "I am going to the market.": "मैं बाज़ार जा रहा हूँ।",
  "The cow gives us milk.": "गाय हमें दूध देती है।",
  "My school is very big.": "मेरा स्कूल बहुत बड़ा है।",
  "We are planting trees in the garden.": "हम बगीचे में पेड़ लगा रहे हैं।",
  "She is wearing a red dress.": "वह लाल पोशाक पहन रही है।",
  "The bird is sitting on the tree.": "पक्षी पेड़ पर बैठा है।",
  "I like to play with toys.": "मुझे खिलौनों से खेलना पसंद है।",
  "The baby is sleeping in the cradle.": "बच्चा पालने में सो रहा है।",
  "My shoes are under the bed.": "मेरे जूते बिस्तर के नीचे हैं।",
  "Do you know how to ride a bicycle?": "क्या आपको साइकिल चलाना आता है?",
  "The sun rises in the east.": "सूरज पूर्व में उगता है।",
  "I drink tea every morning.": "मैं हर सुबह चाय पीता हूँ।",
  "She is writing a letter to her friend.": "वह अपने दोस्त को पत्र लिख रही है।",
  "We are playing in the garden.": "हम बगीचे में खेल रहे हैं।",
  "I saw a rainbow yesterday.": "मैंने कल इंद्रधनुष देखा।",
  "Can you lend me some money?": "क्या आप मुझे कुछ पैसे उधार देंगे?",
  "The stars shine at night.": "सितारे रात को चमकते हैं।",
  "I am brushing my teeth.": "मैं अपने दाँत ब्रश कर रहा हूँ।",
  "They are going to school by bus.": "वे बस से स्कूल जा रहे हैं।",
  "I like to draw pictures.": "मुझे चित्र बनाना पसंद है।",
  "We are planting trees on Sunday.": "हम रविवार को पेड़ लगा रहे हैं।",
  "She is wearing a red dress.": "वह लाल पोशाक पहन रही है।",
  "I hear birds singing in the morning.": "मैं सुबह पक्षियों को गाते हुए सुनता हूँ।",
  "The clock is on the wall.": "घड़ी दीवार पर है।",
  "He is watering the plants.": "वह पौधों को पानी दे रहा है।",
  "Please wash your hands before eating.": "कृपया खाने से पहले अपने हाथ धोएँ।",
  "I am sitting on a chair.": "मैं कुर्सी पर बैठा हूँ।",
  "The cow gives us milk.": "गाय हमें दूध देती है।",
  "My grandfather tells me stories at night.": "मेरे दादा मुझे रात को कहानियाँ सुनाते हैं।",
  "The festival brings joy to everyone.": "त्यौहार सबको खुशी देता है।",
  "We should always speak the truth.": "हमें हमेशा सच बोलना चाहिए।",
  "She sings songs very well.": "वह बहुत अच्छा गाती है।",
  "I keep my room clean and tidy.": "मैं अपना कमरा साफ और व्यवस्थित रखता हूँ।",
  "The bus driver is very friendly.": "बस चालक बहुत मिलनसार है।",
  "Our class teacher teaches us English.": "हमारे कक्षा शिक्षक हमें अंग्रेज़ी पढ़ाते हैं।",
  "I drink plenty of water every day.": "मैं रोज़ भरपूर पानी पीता हूँ।",
  "The dog loves to play with a ball.": "कुत्ते को गेंद से खेलना बहुत पसंद है।",
  "We clap when the performance is good.": "जब प्रदर्शन अच्छा होता है तो हम ताली बजाते हैं।"
};

const speakList = document.querySelector('#speakLessons');
if(speakList){
  speakList.innerHTML = speakLessons.map((s,i)=>`
    <div class="item">
      <span><b>Lesson ${i+1}.</b> ${s}</span>
      <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
        <button class="btn btn-ghost" data-play="${s}">🔊 Listen</button>
        <button class="btn btn-primary" data-say="${s}">I can speak</button>
        <button class="btn btn-ghost" data-translate="${s}">🌍 Translate</button>
      </div>
      <div class="translation muted tiny" id="trans-${i}"></div>
    </div>
  `).join("");

  // 🔊 Listen
  speakList.querySelectorAll('button[data-play]').forEach(b=>{
    b.addEventListener('click', ()=>{
      playSfx('click'); stopSpeaking();
      speak(b.dataset.play,{rate:1, interrupt:true});
    });
  });

  // 🎙 I can speak
  speakList.querySelectorAll('button[data-say]').forEach(b=>{
    b.addEventListener('click', async ()=>{
      playSfx('click'); stopSpeaking();
      const target = b.dataset.say;
      speak("After the beep, please repeat the sentence.", { interrupt:true });
      try{
        await delay(500);
        const transcript = await listenOnce("en-US");
        const score = pronounceScore(target, transcript);
        const msg = score>=0.85 ? "Excellent pronunciation!" :
                    score>=0.65 ? "Good job! Keep practicing." :
                    "Let's try again. Focus on clarity.";
        stopSpeaking(); speak(msg, { interrupt:true });
        alert(`You said: "${transcript}"\nScore: ${(score*100|0)}%\n${msg}`);
      }catch(e){
        alert("Voice input not available on this device.");
      }
    });
  });

  // 🌍 Translate
  speakList.querySelectorAll('button[data-translate]').forEach((btn,i)=>{
    btn.addEventListener('click', ()=>{
      playSfx('click'); stopSpeaking();
      const text = btn.dataset.translate;
      const trans = TRANSLATIONS[text] || "(अनुवाद उपलब्ध नहीं है)";
      document.querySelector('#trans-'+i).textContent = trans;
      speak(trans, { lang:"hi-IN", rate:1, interrupt:true });
    });
  });
}

// ✅ Pronunciation scoring
function pronounceScore(target, said){
  const norm = s=>s.toLowerCase().replace(/[^a-z\s]/g,"").split(/\s+/).filter(Boolean);
  const a = norm(target), b = norm(said);
  const setB = new Set(b);
  const common = a.filter(w=>setB.has(w)).length;
  return common / Math.max(a.length,1);
}

/* ========== MODERN WORDS ========= */
const MODERN = [
  ["Lit","Amazing or exciting.","That concert was lit!"],
  ["Flex","Show off.","He likes to flex his new shoes."],
  ["Low-key","A little; secretly.","I’m low-key nervous about exams."],
  ["High-key","Very; openly.","I’m high-key excited for the trip!"],
  ["Vibe","Mood/feeling of a place.","This café has a cozy vibe."],
  ["Ghost","Suddenly stop replying.","He ghosted the group chat."],
  ["Stan","Devoted fan.","We stan good teachers!"],
  ["Salty","Annoyed or bitter.","She’s salty about losing the game."],
  ["Slay","Do something really well.","You slayed that presentation!"],
  ["No cap","No lie; honestly.","This app helps a lot, no cap."],
  ["Bet","Agreement; okay.","You’ll finish the quiz? Bet."],
  ["Tea","Gossip/news.","Spill the tea later."],
  ["Sus","Suspicious.","That excuse sounds sus."],
  ["IrL","In real life.","I’ll see you IRL tomorrow."],
  ["Yeet","Throw with force/excitement.","He yeeted the ball across the field."],
  ["GOAT","Greatest of all time.","Sachin is the GOAT."],
  ["AF","Very (intensifier).","That puzzle was hard AF."],
  ["Main character","Center of attention.","You’re the main character today!"],
  ["Rizz","Charisma.","He’s got mad rizz."],
  ["Drip","Cool style/outfit.","Nice drip with that jacket!"],
  ["Snack","Attractive person/food lol.","You look like a snack."],
  ["Ate","Did extremely well.","She ate that performance."],
  ["Mid","Mediocre; average.","Movie was mid, tbh."],
  ["Core memory","Very memorable moment.","Winning the medal was a core memory."],
  ["Touch grass","Go outside; relax.","Take a break and touch grass."],
  // 👇 NEW WORDS (shortened here for clarity; keep your full list)
  ["Boujee","Fancy or luxurious.","She only shops at boujee stores."],
  ["Shook","Very shocked or surprised.","I was shook by the announcement."],
  ["Spill","Share the gossip.","Spill what happened yesterday!"],
  ["Shade","Subtle insult.","She threw shade at her ex."],
  ["Savage","Unapologetically bold.","That comeback was savage."],
  ["Extra","Over the top; dramatic.","He’s so extra with his outfits."],
  ["Woke","Socially aware.","She’s very woke about climate issues."],
  ["Clout","Influence or fame.","He did it just for clout."],
  ["Receipts","Proof/screenshots.","Show me the receipts."],
  ["Ship","Support a romantic pairing.","I ship those two."],
  ["Glow-up","Big positive transformation.","He had a serious glow-up."],
  ["Big yikes","Extremely embarrassing.","Forgetting lines was a big yikes."],
  ["Dead","Finding something hilarious.","That meme had me dead."],
  ["Slaps","Really good (song/beat).","This track slaps!"],
  ["Gucci","Good or cool.","Everything’s Gucci now."],
  ["Thicc","Curvy and attractive.","She’s looking thicc today."],
  ["Swole","Muscular.","He’s swole from the gym."],
  ["Fire","Amazing or awesome.","Her outfit is fire."],
  ["Squad","Friend group.","Hanging with the squad tonight."],
  ["Cringe","Awkward or embarrassing.","That dance was cringe."],
  ["Basic","Mainstream or unoriginal.","Pumpkin spice latte is so basic."],
  ["FOMO","Fear of missing out.","I had FOMO when I skipped the party."],
  ["JOMO","Joy of missing out.","Staying in gave me JOMO."],
  ["Boomer","Old-fashioned person.","Okay boomer."],
  ["Periodt","Final statement, no debate.","That’s facts, periodt."],
  ["Aesthetic","Stylish or pleasing look.","Her room has a soft aesthetic."],
  ["Troll","Person who provokes online.","Ignore the trolls."],
  ["Wavy","Cool or stylish.","That haircut is wavy."],
  ["Hits different","Feels unique or stronger.","This song hits different at night."],
  ["TFW","That feeling when.","TFW you finish homework early."],
  ["ICYMI","In case you missed it.","ICYMI, the game got delayed."],
  ["AFK","Away from keyboard.","BRB, AFK for 5 minutes."],
  ["Szn","Season.","It’s spooky szn already."],
  ["Vibing","Enjoying the moment.","We’re vibing to this music."],
  ["Adulting","Doing grown-up tasks.","Paying bills is adulting."],
  ["Drag","To roast or criticize.","She dragged him on Twitter."],
  ["Dank","Really good or funny.","That meme is dank."],
  ["Viral","Quickly spreading online.","That video went viral."],
  ["Sis","Casual way to address a girl.","Listen sis, calm down."],
  ["Bruh moment","Something dumb or unfortunate.","That was such a bruh moment."],
  ["Level up","To improve.","He needs to level up his skills."],
  ["Epic fail","Huge mistake.","That was an epic fail."],
  ["Zaddy","Stylish, attractive older man.","That actor is a zaddy."],
  ["OOTD","Outfit of the day.","Check my OOTD on Insta."],
  ["Squad goals","Ideal friend group vibe.","They’re total squad goals."],
  ["W","A win.","We got the W today."],
  ["L","A loss.","That test was an L."],
  ["Cap or no cap","Lie vs truth.","He’s telling the truth, no cap."],
  ["Mainstream","Popular or common.","That show is mainstream now."],
  ["Glow queen","Girl with amazing transformation.","She’s the glow queen."],
  ["Snack attack","Someone looking tasty/cute.","He’s giving snack attack vibes."],
  ["Cancel","Boycott or reject someone.","He got cancelled last year."],
  ["Stan Twitter","Fan community on Twitter.","Stan Twitter is chaotic."],
  ["Boujee AF","Extremely fancy.","That resort is boujee AF."],
  ["Big mood","Relatable feeling.","Pizza in bed is a big mood."],
  ["NPC","Background/unimportant person.","Stop acting like an NPC."],
  ["Main quest","Most important task.","Finishing exams is the main quest."],
  ["Side quest","Secondary activity.","Cleaning my room is a side quest."],
  ["Cheugy","Outdated or uncool.","Skinny jeans are cheugy now."],
  ["Thirst trap","Attractive photo posted online.","He posted a thirst trap."],
  ["Cook","To perform really well.","He cooked that performance."],
  ["Bussin","Really good (esp. food).","This pizza is bussin."],
  ["It’s giving","The vibe or feeling.","That outfit is giving luxury."],
  ["Based","Confidently true/opinionated.","That take is based."],
  ["Delulu","Delusional belief.","He’s delulu if he thinks she likes him."],
  ["Ick","Turn-off in attraction.","Chewing loudly is such an ick."],
  ["Situationship","Casual undefined relationship.","They’re in a situationship."],
  ["Touch base","Check-in or update.","Let’s touch base later."],
];

/* 🔹 Hindi Translations */
const MODERN_HINDI = {
  "Lit": "शानदार या रोमांचक",
  "Flex": "दिखावा करना",
  "Low-key": "थोड़ा सा; गुप्त रूप से",
  "High-key": "बहुत ज़्यादा; खुलकर",
  "Vibe": "माहौल या भावना",
  "Ghost": "अचानक जवाब देना बंद करना",
  "Stan": "बहुत बड़ा प्रशंसक",
  "Salty": "नाराज़ या खिन्न",
  "Slay": "बहुत अच्छा करना",
  "No cap": "सच में; झूठ नहीं",
  "Bet": "ठीक है; सहमति",
  "Tea": "गपशप / खबर",
  "Sus": "संदिग्ध",
  "IrL": "वास्तविक जीवन में",
  "Yeet": "जोर से फेंकना",
  "GOAT": "सर्वश्रेष्ठ (Greatest of all time)",
  "AF": "बहुत ज़्यादा",
  "Main character": "मुख्य पात्र",
  "Rizz": "आकर्षण / करिश्मा",
  "Drip": "कूल स्टाइल / कपड़े",
  "Snack": "आकर्षक व्यक्ति या खाना",
  "Ate": "बहुत अच्छा किया",
  "Mid": "औसत; साधारण",
  "Core memory": "बहुत यादगार पल",
  "Touch grass": "बाहर जाओ; आराम करो",
  "Boujee": "शानदार या महँगा",
  "Shook": "चकित या हैरान",
  "Spill": "गपशप बताना",
  "Shade": "हल्का अपमान",
  "Savage": "बेबाक और निडर",
  "Extra": "बहुत ज़्यादा; नाटकीय",
  "Woke": "सामाजिक रूप से जागरूक",
  "Clout": "प्रभाव या शोहरत",
  "Receipts": "सबूत / स्क्रीनशॉट",
  "Ship": "रोमांटिक जोड़ी का समर्थन करना",
  "Glow-up": "बड़ा सकारात्मक बदलाव",
  "Big yikes": "बहुत शर्मनाक",
  "Dead": "बहुत हँसना",
  "Slaps": "बहुत बढ़िया (गीत/धुन)",
  "Gucci": "अच्छा / कूल",
  "Thicc": "आकर्षक और भारी",
  "Swole": "मज़बूत / मसलदार",
  "Fire": "शानदार / शानदार",
  "Squad": "दोस्तों का समूह",
  "Cringe": "अजीब या शर्मनाक",
  "Basic": "साधारण / आम",
  "FOMO": "कुछ मिस करने का डर",
  "JOMO": "कुछ मिस करने की खुशी",
  "Boomer": "पुराने ख्यालों वाला व्यक्ति",
  "Periodt": "अंतिम बयान, कोई बहस नहीं",
  "Aesthetic": "स्टाइलिश / सुंदर लुक",
  "Troll": "ऑनलाइन परेशान करने वाला व्यक्ति",
  "Wavy": "कूल या स्टाइलिश",
  "Hits different": "अलग असर डालना",
  "TFW": "वो एहसास जब...",
  "ICYMI": "अगर आपसे छूट गया हो",
  "AFK": "कंप्यूटर से दूर",
  "Szn": "सीज़न / मौसम",
  "Vibing": "पल का आनंद लेना",
  "Adulting": "बड़ों जैसा काम करना",
  "Dank": "बहुत अच्छा या मजेदार",
  "Viral": "तेजी से फैलना",
  "Sis": "अनौपचारिक संबोधन (बहन जैसी)",
  "Bruh moment": "मूर्खतापूर्ण पल",
  "Level up": "सुधार करना",
  "Epic fail": "बड़ी गलती",
  "Zaddy": "स्टाइलिश आकर्षक व्यक्ति",
  "W": "जीत",
  "L": "हार",
  "Based": "सही और आत्मविश्वासी राय",
  "Delulu": "भ्रमित विश्वास",
  "Situationship": "अनिश्चित रिश्ता",
  "Touch base": "संपर्क करना / अपडेट करना"
};

/* Render Modern Words */
const modernList = $('#modernList');
if(modernList){
  modernList.innerHTML = MODERN.map(([w,m,e],i)=>`
    <div class="item">
      <b>${i+1}. ${escapeHtml(w)}</b> — ${escapeHtml(m)} 
      <i class="muted">(${escapeHtml(e)})</i>
      <div style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
        <button class="btn btn-ghost" data-say="${escapeHtmlAttr(`${w}. ${m}. Example: ${e}`)}">🔊 Listen</button>
        <button class="btn btn-primary" data-translate="${escapeHtmlAttr(w)}">🌍 Translate</button>
      </div>
      <div class="translation muted tiny" id="mod-trans-${i}"></div>
    </div>
  `).join("");

  // 🔊 Listen
  modernList.querySelectorAll('button[data-say]').forEach(b=>{
    b.addEventListener('click', ()=>{
      playSfx('click'); stopSpeaking();
      speak(b.dataset.say,{rate:1.05, interrupt:true});
    });
  });

  // 🌍 Translate
  modernList.querySelectorAll('button[data-translate]').forEach((btn,i)=>{
    btn.addEventListener('click', ()=>{
      playSfx('click'); stopSpeaking();
      const word = btn.dataset.translate;
      const trans = MODERN_HINDI[word] || "(अनुवाद उपलब्ध नहीं है)";
      $('#mod-trans-'+i).textContent = trans;
      speak(trans, { lang:"hi-IN", rate:1, interrupt:true });
    });
  });
}

/* ========== QUIZ RENDERER (interrupt-safe & reports completion) ========= */
function renderQuiz(root, questions, {announce=false, onComplete=null}={}){
  if(!root) return;
  let score=0, idx=0;
  root.innerHTML = "";
  const renderOne = ()=>{
    if(idx>=questions.length){
      root.innerHTML = `<div class="q"><b>Done!</b> Score: ${score}/${questions.length}</div>`;
      stopSpeaking();
      speak(`You scored ${score} out of ${questions.length}.`, { interrupt:true });
      if(onComplete) onComplete();
      // Important: record quiz completion (this will show the claim modal if eligible)
      // small delay to let score TTS finish before showing popup
      setTimeout(()=>{ recordQuizCompletion('quiz'); }, 700);
      return;
    }
    const q = questions[idx];
    const choices = q.choices.map(x=>String(x));
    root.innerHTML = `
      <div class="q">
        <div><b>Q${idx+1}.</b> ${escapeHtml(q.q)}</div>
        <div>${choices.map((c,i)=>`<button class="choice" data-i="${i}">${escapeHtml(c)}</button>`).join("")}</div>
      </div>
    `;
    if(announce){
      const speakQ = speakify(q.q);
      const speakOpts = choices.join(', ');
      stopSpeaking();
      speak(`Question ${idx+1}. ${speakQ}. Options: ${speakOpts}`, { interrupt:true });
    }
    root.querySelectorAll('.choice').forEach(b=>{
      b.addEventListener('click', ()=>{
        stopSpeaking(); // stop any ongoing TTS (critical)
        const i = Number(b.dataset.i);
        const isCorrect = String(choices[i]) === String(q.correctAnswer);
        if(isCorrect){ b.classList.add('correct'); playSfx("correct"); speak("Correct!", { interrupt:true }); score++; }
        else { b.classList.add('wrong'); playSfx("wrong"); speak(`Incorrect. The correct answer is ${q.correctAnswer}`, { interrupt:true }); }
        root.querySelectorAll('.choice').forEach(x=>x.disabled=true);
        setTimeout(()=>{ idx++; renderOne(); }, 350);
      });
    });
  };
  renderOne();
}

function speakify(text){
  if(!text) return "";
  return String(text)
    .replace(/×/g,' times ')
    .replace(/÷/g,' divided by ')
    .replace(/\+/g,' plus ')
    .replace(/(\d)\s*-\s*(\d)/g, '$1 minus $2')
    .replace(/\s+/g,' ');
}

/* ========== SVG utility ========== */
function makeSVGDataURL({ title='', subtitle='', emoji='📘', width=360, height=160, bg='#fff', color='#222' } = {}){
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" rx="12" fill="${bg}"/>
    <g>
      <text x="22" y="44" font-size="22" font-weight="700" fill="${color}" font-family="Inter, sans-serif">${escapeForSvg(title)}</text>
      <text x="22" y="74" font-size="14" fill="#555" font-family="Inter, sans-serif">${escapeForSvg(subtitle)}</text>
      <text x="${width-70}" y="${height-30}" font-size="40">${escapeForSvg(emoji)}</text>
    </g>
  </svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function escapeForSvg(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function injectModuleIllustrations(){
  const modules = [
    {id:'dictionary', title:'Dictionary', subtitle:'Word meanings & pronunciation', emoji:'📖', bg:'#e8f0fe'},
    {id:'englishLearning', title:'English Learning', subtitle:'100 sentences per class', emoji:'📚', bg:'#fff3e0'},
    {id:'childABC', title:'Child ABC', subtitle:'A–Z with pictures', emoji:'🍎', bg:'#f3e5f5'},
    {id:'childMath', title:'Child Math', subtitle:'Daily math practice', emoji:'➗', bg:'#e8f5e9'},
    {id:'englishQuiz', title:'English Quiz', subtitle:'Daily MCQs', emoji:'📝', bg:'#fce4ec'},
    {id:'tables', title:'Maths Tables', subtitle:'Tables 1–40', emoji:'🔢', bg:'#ede7f6'},
    {id:'gk', title:'General Knowledge', subtitle:'Top GK questions', emoji:'🌍', bg:'#e0f7fa'},
    {id:'leaderboard', title:'Leaderboards', subtitle:'Top streaks', emoji:'🏆', bg:'#fff8e1'},
    {id:'speaking', title:'Speaking Coach', subtitle:'Practice speaking', emoji:'🎤', bg:'#e0f2f1'},
    {id:'modernWords', title:'Modern Words', subtitle:'Gen-Z vocabulary', emoji:'✨', bg:'#f9fbe7'},
    {id:'miniGames', title:'Mini Games', subtitle:'Play & save high scores', emoji:'🎮', bg:'#fff1f8'}
  ];
  modules.forEach(m=>{
    const sec = document.getElementById(m.id);
    if(!sec) return;
    const card = sec.querySelector('.card');
    if(!card) return;
    if(card.querySelector('.module-illustration')) return;
    const img = document.createElement('img');
    img.className = 'module-illustration';
    img.alt = m.title;
    img.src = makeSVGDataURL({title: m.title, subtitle: m.subtitle, emoji: m.emoji, bg:m.bg});
    card.insertBefore(img, card.firstChild);
  });
}

/* ========== HIGH SCORES (local+cloud) ========== */
function highScoreKey(){ return `speakroots_highscores_${state.user?.uid||'local'}`; }
function getHighScores(){ try{ const raw = localStorage.getItem(highScoreKey()); return raw ? JSON.parse(raw) : {}; }catch{return {}} }
function saveHighScores(obj){ localStorage.setItem(highScoreKey(), JSON.stringify(obj)); /* optional cloud sync omitted for brevity */ renderHighScorePanel(); }
function updateHighScore(gameKey, score){
  const hs = getHighScores();
  const prev = Number(hs[gameKey]||0);
  if(score > prev){ hs[gameKey] = score; saveHighScores(hs); }
}
function renderHighScorePanel(){
  const wrap = $('#gameHighscores');
  if(!wrap) return;
  const hs = getHighScores();
  const keys = ['spellingBee','wordMatch','wordRace'];
  wrap.innerHTML = keys.map(k=>{
    const label = k==='spellingBee'?'Spelling Bee':k==='wordMatch'?'Word Match':'Word Race';
    return `<div class="highscore-row"><div>${label}</div><div>${hs[k]||0} pts</div></div>`;
  }).join('');
}

/* ========== MINI GAMES (Spelling, Match, Race) ========== */
const GAME_WORDS_ALL = ["apple","ball","cat","dog","book","tree","sun","moon","car","school","water","bird","fish","hat","pen","door","chair","table","rice","friend","family","market","teacher","elephant","hospital"];
const PAIRS = [
  {w:"apple", d:"A round sweet fruit"},
  {w:"ball", d:"A round object used in games"},
  {w:"cat", d:"A small furry animal that says meow"},
  {w:"apple", d:"A round sweet fruit"},
  {w:"ball", d:"A round object used in games"},
  {w:"cat", d:"A small furry animal that says meow"},
  {w:"dog", d:"A pet that barks"},
  {w:"book", d:"You read it to learn"},
  {w:"car", d:"A vehicle with four wheels"},
  {w:"sun", d:"The star that keeps us warm"},
  {w:"tree", d:"A tall plant with a trunk"},
  {w:"pen", d:"A tool used for writing"},
  {w:"chair", d:"A seat with four legs"},
  {w:"house", d:"A place where people live"},
  {w:"milk", d:"A white drink from cows"},
  {w:"fish", d:"An animal that swims in water"},
  {w:"bird", d:"An animal that can fly"},
  {w:"shoe", d:"You wear it on your foot"},
  {w:"phone", d:"A device to call people"},
  {w:"clock", d:"It tells the time"},
  {w:"water", d:"A clear liquid we drink"},
  {w:"river", d:"A natural stream of water"},
  {w:"mountain", d:"A very high hill"},
  {w:"computer", d:"A machine used for work and play"},
  {w:"bag", d:"You carry books in it"},
  {w:"train", d:"A vehicle that runs on tracks"},
  {w:"bus", d:"A big vehicle for many passengers"},
  {w:"road", d:"Cars run on this"},
  {w:"teacher", d:"A person who teaches students"},
  {w:"student", d:"A person who learns in school"},
  {w:"school", d:"A place where children study"},
  {w:"hospital", d:"A place where sick people are treated"},
  {w:"doctor", d:"A person who treats sick people"},
  {w:"nurse", d:"A person who helps doctors"},
  {w:"police", d:"They protect the people"},
  {w:"fire", d:"Something that burns and gives heat"},
  {w:"rain", d:"Water that falls from the sky"},
  {w:"cloud", d:"White things floating in the sky"},
  {w:"star", d:"A shining point in the night sky"},
  {w:"moon", d:"It shines at night"},
  {w:"family", d:"Parents and children together"},
  {w:"friend", d:"A person you like and trust"},
  {w:"market", d:"A place to buy and sell things"},
  {w:"money", d:"We use it to buy things"},
  {w:"food", d:"Something we eat"},
  {w:"cake", d:"A sweet food for birthdays"},
  {w:"bread", d:"Baked food made of flour"},
  {w:"egg", d:"A round food from hens"},
  {w:"rice", d:"Small white grains we cook"},
  {w:"sugar", d:"It makes food sweet"},
  {w:"salt", d:"It makes food salty"},
  {w:"butter", d:"A soft yellow dairy food"},
  {w:"oil", d:"A liquid used for cooking"},
  {w:"fruit", d:"Sweet part of a plant we eat"},
  {w:"vegetable", d:"Plant food like carrot or potato"},
  {w:"potato", d:"A brown vegetable grown underground"},
  {w:"onion", d:"A vegetable that makes you cry"},
  {w:"tomato", d:"A red vegetable or fruit"},
  {w:"banana", d:"A long yellow fruit"},
  {w:"grape", d:"A small round fruit"},
  {w:"mango", d:"A sweet tropical fruit"},
  {w:"orange", d:"A round citrus fruit"},
  {w:"lemon", d:"A sour yellow fruit"},
  {w:"bike", d:"A two-wheeled vehicle"},
  {w:"truck", d:"A big vehicle to carry goods"},
  {w:"aeroplane", d:"A flying vehicle"},
  {w:"ship", d:"A big boat for travel in sea"},
  {w:"boat", d:"A small vehicle on water"},
  {w:"door", d:"You open and close it to enter"},
  {w:"window", d:"An opening in a wall for air and light"},
  {w:"key", d:"It opens a lock"},
  {w:"lock", d:"Used to close doors safely"},
  {w:"bed", d:"We sleep on it"},
  {w:"pillow", d:"We rest our head on it"},
  {w:"blanket", d:"Used to keep warm at night"},
  {w:"shirt", d:"Clothes for the upper body"},
  {w:"pants", d:"Clothes for the legs"},
  {w:"hat", d:"You wear it on your head"},
  {w:"dress", d:"Clothing for girls or women"},
  {w:"watch", d:"You wear it to see time"},
  {w:"ring", d:"A small circle worn on finger"},
  {w:"gold", d:"A yellow precious metal"},
  {w:"silver", d:"A shiny white metal"},
  {w:"diamond", d:"A very hard precious stone"},
  {w:"paper", d:"We write on it"},
  {w:"pencil", d:"We write or draw with it"},
  {w:"eraser", d:"Used to remove pencil marks"},
  {w:"sharpener", d:"Used to sharpen pencils"},
  {w:"map", d:"Shows countries and cities"},
  {w:"flag", d:"Symbol of a country"},
  {w:"game", d:"Something we play for fun"},
  {w:"music", d:"Pleasant sounds we listen to"},
  {w:"song", d:"Words sung with music"},
  {w:"dance", d:"Moving with music"},
  {w:"movie", d:"A film we watch"},
  {w:"photo", d:"A picture taken by a camera"},
  {w:"camera", d:"Device to take pictures"},
  {w:"glass", d:"We drink water in it"},
  {w:"plate", d:"We eat food on it"},
  {w:"spoon", d:"Used for eating or serving food"},
  {w:"knife", d:"Used for cutting food"},
  {w:"fork", d:"Used for eating food"},
  {w:"cup", d:"Used to drink tea or coffee"},
  {w:"schoolbag", d:"Bag used by students"},
  {w:"notebook", d:"A book used for writing notes"},
  {w:"letter", d:"A written message"},
  {w:"postman", d:"A person who delivers letters"},
  {w:"farmer", d:"A person who grows crops"}
];
$('#openSpelling')?.addEventListener('click', ()=>{ playSfx('click'); openSpellingBee(); });
$('#openMatch')?.addEventListener('click', ()=>{ playSfx('click'); openWordMatch(); });
$('#openRace')?.addEventListener('click', ()=>{ playSfx('click'); openWordRace(); });
renderHighScorePanel();

/* Spelling Bee */
function openSpellingBee(){
  const area = $('#gameArea'); if(!area) return;
  area.innerHTML = '';
  const container = document.createElement('div'); container.className='game-board';
  container.innerHTML = `
    <div class="game-header">
      <div class="score">Score: <span id="spScore">0</span></div>
      <div class="timer">Word <span id="spIndex">0</span> / <span id="spTotal">10</span></div>
    </div>
    <div id="spPlayHint" class="hint muted">Speak Roots will say a word — type it and press Submit.</div>
    <div style="display:flex;gap:8px;margin-top:8px;">
      <button id="spPlayWord" class="btn btn-ghost">🔊 Play Word</button>
      <button id="spReplay" class="btn btn-ghost">Replay</button>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center;">
      <input id="spInput" placeholder="Type the word here" style="flex:1;padding:10px;border-radius:10px;border:1px solid #eee" />
      <button id="spSubmit" class="btn btn-primary">Submit</button>
    </div>
    <div id="spFeedback" class="hint" style="margin-top:8px;"></div>
  `;
  area.appendChild(container);

  const total = 10;
  let pool = shuffle([...GAME_WORDS_ALL]).slice(0,total);
  let idx = 0; let score = 0;
  $('#spTotal').textContent = total; $('#spIndex').textContent = idx+1; $('#spScore').textContent = score;

  function playCurrent(){ const w = pool[idx]; stopSpeaking(); speak(w, {rate:0.95, interrupt:true}); }
  $('#spPlayWord')?.addEventListener('click', ()=>{ playSfx('click'); playCurrent(); });
  $('#spReplay')?.addEventListener('click', ()=>{ playSfx('click'); playCurrent(); });

  $('#spSubmit')?.addEventListener('click', ()=>{
    stopSpeaking();
    const val = ($('#spInput').value||"").trim().toLowerCase();
    const correct = pool[idx].toLowerCase();
    if(!val){ $('#spFeedback').textContent = 'Please type the word you hear.'; return; }
    if(val === correct){
      score += 10; $('#spFeedback').textContent = `Correct! "${correct}"`; playSfx('correct'); speak("Great! Correct.", { interrupt:true });
    } else {
      $('#spFeedback').textContent = `Oops. Correct word: "${correct}"`; playSfx('wrong'); speak(`Not quite. The correct word is ${correct}`, { interrupt:true });
    }
    $('#spScore').textContent = score; idx++; $('#spIndex').textContent = Math.min(idx+1,total); $('#spInput').value='';
    if(idx >= total){ setTimeout(()=>{ finishSpelling(score); }, 500); } else { setTimeout(()=>{ playCurrent(); }, 450); }
  });

  setTimeout(()=>{ playCurrent(); }, 400);
}

function finishSpelling(score){
  updateHighScore('spellingBee', score);
  const area = $('#gameArea'); if(!area) return;
  area.innerHTML = `<div class="game-board"><h3>Spelling Bee Complete</h3><p>Your score: <b>${score}</b></p><div style="margin-top:8px"><button class="btn btn-primary" id="spRetry">Play again</button> <button class="btn btn-ghost" id="spBack">Back to games</button></div></div>`;
  $('#spRetry')?.addEventListener('click', openSpellingBee);
  $('#spBack')?.addEventListener('click', ()=>{ showScreen('miniGames'); renderHighScorePanel(); });
  // record completion for streak popup
  setTimeout(()=> recordQuizCompletion('spelling'), 350);
}

/* Word Match */
function openWordMatch(){
  const area = $('#gameArea'); if(!area) return;
  area.innerHTML = '';
  const container = document.createElement('div'); container.className='game-board';
  container.innerHTML = `
    <div class="game-header">
      <div class="score">Score: <span id="wmScore">0</span></div>
      <div class="timer">Pairs left: <span id="wmLeft">0</span></div>
    </div>
    <div id="wmGrid" class="pair-grid"></div>
    <div id="wmFeedback" class="hint" style="margin-top:8px;"></div>
    <div style="margin-top:12px;"><button id="wmBack" class="btn btn-ghost">Back to games</button></div>
  `;
  area.appendChild(container);

  const pairs = shuffle([...PAIRS]).slice(0,4);
  const words = shuffle(pairs.map(p=>p.w));
  const defs = shuffle(pairs.map(p=>p.d));
  $('#wmLeft').textContent = pairs.length; $('#wmScore').textContent = 0;
  const grid = $('#wmGrid');
  grid.innerHTML = `<div>${words.map(w=>`<div class="word-card" data-word="${escapeHtmlAttr(w)}">${escapeHtml(w)}</div>`).join('')}</div><div>${defs.map(d=>`<div class="def-card" data-def="${escapeHtmlAttr(d)}">${escapeHtml(d)}</div>`).join('')}</div>`;

  let selectedWord = null; let matchedCount=0; let score=0;
  grid.querySelectorAll('.word-card').forEach(wc=>{
    wc.addEventListener('click', ()=>{ if(wc.classList.contains('matched')) return; grid.querySelectorAll('.word-card').forEach(x=>x.classList.remove('selected')); grid.querySelectorAll('.def-card').forEach(x=>x.classList.remove('selected')); wc.classList.add('selected'); selectedWord = wc.dataset.word; });
  });
  grid.querySelectorAll('.def-card').forEach(dc=>{
    dc.addEventListener('click', ()=>{ stopSpeaking(); if(dc.classList.contains('matched')) return; grid.querySelectorAll('.def-card').forEach(x=>x.classList.remove('selected')); dc.classList.add('selected'); const defText = dc.dataset.def; if(!selectedWord){ $('#wmFeedback').textContent='Select a word first.'; return; } const pairFound = pairs.find(p=>p.w===selectedWord && p.d===defText); if(pairFound){ grid.querySelectorAll(`[data-word="${escapeHtmlAttr(selectedWord)}"]`).forEach(n=>n.classList.add('matched')); grid.querySelectorAll(`[data-def="${escapeHtmlAttr(defText)}"]`).forEach(n=>n.classList.add('matched')); score+=10; matchedCount++; $('#wmScore').textContent=score; $('#wmLeft').textContent = pairs.length - matchedCount; $('#wmFeedback').textContent = `Good! "${selectedWord}" → matched.`; playSfx('correct'); stopSpeaking(); speak(`Good! ${selectedWord} matched.`, { interrupt:true }); selectedWord=null; if(matchedCount>=pairs.length){ setTimeout(()=> finishMatch(score), 700); } } else { $('#wmFeedback').textContent='Wrong pair. Try again.'; playSfx('wrong'); stopSpeaking(); speak('Not quite, try again.', { interrupt:true }); dc.classList.add('wrong'); setTimeout(()=>dc.classList.remove('wrong'),400); } });
  });

  $('#wmBack')?.addEventListener('click', ()=>{ showScreen('miniGames'); renderHighScorePanel(); });
}

function finishMatch(score){
  updateHighScore('wordMatch', score);
  const area = $('#gameArea'); if(!area) return;
  area.innerHTML = `<div class="game-board"><h3>Word Match Complete</h3><p>Your score: <b>${score}</b></p><div style="margin-top:8px"><button class="btn btn-primary" id="wmRetry">Play again</button> <button class="btn btn-ghost" id="wmBack2">Back to games</button></div></div>`;
  $('#wmRetry')?.addEventListener('click', openWordMatch);
  $('#wmBack2')?.addEventListener('click', ()=>{ showScreen('miniGames'); renderHighScorePanel(); });
  setTimeout(()=> recordQuizCompletion('match'), 350);
}

/* Word Race (timed MCQ) */
function openWordRace(){
  const area = $('#gameArea'); if(!area) return;
  area.innerHTML = '';
  const container = document.createElement('div'); container.className='game-board';
  container.innerHTML = `
    <div class="game-header">
      <div class="score">Score: <span id="wrScore">0</span></div>
      <div class="timer">Time Left: <span id="wrTimer">30</span>s</div>
    </div>
    <div id="wrQArea" style="margin-top:12px;"></div>
    <div id="wrFeedback" class="hint" style="margin-top:8px;"></div>
    <div style="margin-top:12px;"><button id="wrBack" class="btn btn-ghost">Back to games</button></div>
  `;
  area.appendChild(container);
  const pool = makeEnglishPool("3"); const qPool = shuffle(pool).slice(0,200);
  let score = 0; let timeLeft = 30; let timerId = null;
  $('#wrScore').textContent = score; $('#wrTimer').textContent = timeLeft;

  function nextQuestion(){
    if(timeLeft <= 0){ finishRace(score); return; }
    const q = qPool[Math.floor(Math.random()*qPool.length)];
    const choices = q.choices.slice();
    const container = $('#wrQArea');
    container.innerHTML = `<div><b>${escapeHtml(q.q)}</b></div><div style="margin-top:8px">${choices.map((c,i)=>`<button class="btn choice-wr" data-i="${i}" style="margin:4px">${escapeHtml(c)}</button>`).join("")}</div>`;
    stopSpeaking(); speak(q.q, { interrupt:true });
    container.querySelectorAll('.choice-wr').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        stopSpeaking();
        const chosen = btn.textContent;
        if(String(chosen) === String(q.correctAnswer)){ score += 5; $('#wrScore').textContent = score; $('#wrFeedback').textContent = 'Correct!'; playSfx('correct'); speak('Correct', { interrupt:true }); }
        else { $('#wrFeedback').textContent = `Wrong — correct: ${q.correctAnswer}`; playSfx('wrong'); speak(`Wrong. The correct answer is ${q.correctAnswer}`, { interrupt:true }); }
        setTimeout(()=>{ nextQuestion(); }, 350);
      });
    });
  }

  function tick(){ timeLeft--; $('#wrTimer').textContent = timeLeft; if(timeLeft <= 0){ clearInterval(timerId); finishRace(score); } }
  timerId = setInterval(tick, 1000);
  nextQuestion();

  $('#wrBack')?.addEventListener('click', ()=>{
    if(timerId) clearInterval(timerId);
    stopSpeaking();
    showScreen('miniGames');
    renderHighScorePanel();
  });
}

function finishRace(score){
  updateHighScore('wordRace', score);
  stopSpeaking();
  const area = $('#gameArea'); if(!area) return;
  area.innerHTML = `<div class="game-board"><h3>Word Race Over</h3><p>Your score: <b>${score}</b></p><div style="margin-top:8px"><button class="btn btn-primary" id="wrRetry">Play again</button> <button class="btn btn-ghost" id="wrBack2">Back to games</button></div></div>`;
  $('#wrRetry')?.addEventListener('click', openWordRace);
  $('#wrBack2')?.addEventListener('click', ()=>{ showScreen('miniGames'); renderHighScorePanel(); });
  setTimeout(()=> recordQuizCompletion('race'), 350);
}

/* ========== DAILY STREAK STORAGE HELPERS (used above) ========== */
function getDailyState(){ return getDailyState_raw(); }
function getDailyState_raw(){
  const raw = localStorage.getItem(dailyKey());
  const today = todayKey();
  if(!raw) return { date: today, completed: 0, claimed: false };
  try{
    const obj = JSON.parse(raw);
    if(obj.date !== today) return { date: today, completed: 0, claimed: false };
    return obj;
  }catch(e){ return { date: today, completed: 0, claimed: false }; }
}
function setDailyState(obj){ obj.date = todayKey(); localStorage.setItem(dailyKey(), JSON.stringify(obj)); }

/* ========== FINAL INITIALIZATION ========== */
document.querySelectorAll('.screen .menu-btn').forEach(b=>{
  b.addEventListener('click', ()=>{ playSfx('click'); showScreen('menu'); });
});
updateStreakUI();
renderHighScorePanel();

/* ========== HELPER PICK ========== */
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }


/* ===================== REGISTER NEW SCREENS ===================== */
try{
  if (Array.isArray(screens)) {
    if(!screens.includes('profile')) screens.push('profile');
    if(!screens.includes('community')) screens.push('community');
  }
}catch(e){ /* non-fatal */ }

/* ===================== PROFILE MODULE ===================== */
(function profileModule(){
  const el = {
    name: $('#profileName'),
    usernameShow: $('#profileUsernameShow'),
    email: $('#profileEmail'),
    uid: $('#profileUID'),
    avatar: $('#profileAvatar'),
    streak: $('#profileStreak'),
    today: $('#profileToday'),
    last: $('#profileLast'),

    fName: $('#pfName'),
    fUsername: $('#pfUsername'),
    fPhone: $('#pfPhone'),

    save: $('#profileSaveBtn'),
    copyUid: $('#profileCopyUid'),
    resetLocal: $('#resetLocalBtn'),
    download: $('#downloadDataBtn'),
    logout: $('#profileLogoutBtn'),
  };

  function caps(s){ s = String(s||''); return s ? s.trim()[0].toUpperCase() : 'S'; }
  function initials(name){ name = String(name||'').trim(); if(!name) return 'SR';
    const parts = name.split(/\s+/).slice(0,2);
    return parts.map(p=>p[0]?.toUpperCase()||'').join('') || 'SR';
  }

  function setAvatar(){
    try{
      const nm = state?.user?.name || 'Learner';
      el.avatar.textContent = initials(nm);
    }catch{}
  }

  function renderProfile(){
    const u = state.user || { uid:'local' };
    el.name.textContent = u.name || 'Learner';
    el.usernameShow.textContent = u.username || '—';
    el.email.textContent = u.email || '—';
    el.uid.textContent = u.uid || 'local';

    el.fName.value = u.name || '';
    el.fUsername.value = u.username || '';
    el.fPhone.value = u.phone || '';

    el.streak.textContent = String(state.streakDays || 0);
    const daily = (typeof getDailyState === 'function') ? getDailyState() : { completed:0, claimed:false };
    el.today.textContent = daily.completed ? 'Yes' : 'No';
    el.last.textContent = state.lastStreakDate || '—';

    setAvatar();
  }

  async function persistProfile(partial){
    // merge into local state
    state.user = { ...(state.user||{}), ...partial };
    // save to local & cloud using your existing helpers
    try{ saveLocal(); }catch{}
    try{ await saveToCloud(); }catch{}
  }

  el.save?.addEventListener('click', async ()=>{
    playSfx?.('click');
    const name = el.fName.value.trim();
    const username = el.fUsername.value.trim();
    const phone = el.fPhone.value.trim();
    await persistProfile({ name, username, phone });
    renderProfile();
    alert('Profile updated.');
  });

  el.copyUid?.addEventListener('click', async ()=>{
    playSfx?.('click');
    try{
      await navigator.clipboard.writeText(String(state.user?.uid||'local'));
      alert('UID copied.');
    }catch{ alert('Copy not supported on this device.'); }
  });

  el.download?.addEventListener('click', ()=>{
    playSfx?.('click');
    const data = {
      user: state.user||{},
      streakDays: state.streakDays||0,
      lastStreakDate: state.lastStreakDate||null,
      daily: (typeof getDailyState==='function') ? getDailyState() : {},
      highscores: (function(){
        try{
          const key = `speakroots_highscores_${state.user?.uid||'local'}`;
          return JSON.parse(localStorage.getItem(key)||'{}');
        }catch{ return {}; }
      })()
    };
    const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'speakroots-data.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 500);
  });

  el.resetLocal?.addEventListener('click', ()=>{
    playSfx?.('click');
    if(!confirm('This will clear local progress (streak/day/highscores) for this user on this device. This cannot be undone. Continue?')) return;
    try{
      const uid = state.user?.uid || 'local';
      localStorage.removeItem(`speakroots_profile_${uid}`);
      localStorage.removeItem(`speakroots_daily_${uid}`);
      localStorage.removeItem(`speakroots_highscores_${uid}`);
      state.streakDays = 0;
      state.lastStreakDate = null;
      renderProfile();
      updateStreakUI?.();
      alert('Local data cleared.');
    }catch(e){ alert('Could not clear local data.'); }
  });

  // Reuse your existing header Logout too; this is a convenience button on profile screen
  el.logout?.addEventListener('click', ()=>{
    playSfx?.('click');
    $('#logoutBtn')?.click();
  });

  // open handler
  document.querySelector('[data-target="profile"]')?.addEventListener('click', ()=>{
    renderProfile();
    showScreen('profile');
  });

  // Also render when screen becomes visible via menu-btn back and forth
  // (safe to call on demand)
  window.renderProfile = renderProfile;
})();

/* ===================== COMMUNITY CHAT MODULE (Supabase chat) ===================== */
(function chatModule(){
  // ---------- Config ----------
  const CHAT_SUPABASE_URL = 'https://bexrrihldomykdetkqut.supabase.co';
  const CHAT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJleHJyaWhsZG9teWtkZXRrcXV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk2NTg1MjQsImV4cCI6MjA3NTIzNDUyNH0.UCsM6s0-ESAOIVX6SiVdQAFqg268AmWNDycV1wi8PTg';

  const profanity = /\b(fuck|shit|bitch|asshole|bastard|dick|cunt|nigger|chutiya|madarchod|bhenchod)\b/i;
  const MAX_LOCAL = 200; // cap messages per channel locally

  // ---------- DOM ----------
  const els = {
    tabs: $('#chatTabs'),
    list: $('#chatList'),
    input: $('#chatInput'),
    send: $('#chatSend'),
    status: $('#chatStatus'),
    chatNameDisplay: $('#chatNameDisplay'),
    myChatName: $('#myChatName'),
    changeChatNameBtn: $('#changeChatNameBtn'),
    chatNameModal: $('#chatNameModal'),
    chatNameInput: $('#chatNameInput'),
    chatNameFeedback: $('#chatNameFeedback'),
    saveChatNameBtn: $('#saveChatNameBtn'),
    cancelChatNameBtn: $('#cancelChatNameBtn'),
    messageTemplate: $('#chatMessageTemplate')
  };

  // ---------- State ----------
  const channels = ['general','doubts','tips'];
  let channel = 'general';
  let realtimeChannel = null;
  let chatSupabase = null;
  let chatInitResolved = false;
  let myChatName = null;

  // local storage key per chat project + uid
  const CHAT_NAME_KEY = `brx_chat_name_${(new URL(CHAT_SUPABASE_URL)).hostname}`;

  // ---------- helpers ----------
  function uid(){ return state?.user?.uid || 'local'; }
  function uname(){ return state?.user?.name || state?.user?.username || 'Learner'; }
  function avatarOf(n){ n = String(n||''); const a = n.trim().split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase(); return a||'SR'; }

  function escapeHtml(unsafe){
    if(!unsafe) return '';
    return String(unsafe)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'", '&#39;');
  }

  function localKey(ch){ return `speakroots_chat_${ch}`; }
  function loadLocal(ch){
    try{ return JSON.parse(localStorage.getItem(localKey(ch))||'[]'); }catch{ return []; }
  }
  function saveLocal(ch, arr){
    try{ localStorage.setItem(localKey(ch), JSON.stringify(arr.slice(-MAX_LOCAL))); }catch{}
  }

  function timeStrFrom(value){
    if(!value) return '—';
    let t = null;
    // created_at might be ISO string or JS timestamp or Date object
    if(typeof value === 'number') t = value;
    else if(typeof value === 'string'){
      const parsed = Date.parse(value);
      t = isNaN(parsed) ? Date.now() : parsed;
    } else if(value instanceof Date) t = value.getTime();
    else t = Date.now();
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    return `${hh}:${mm}`;
  }

  function normalizeRow(r){
    // convert DB row or local row to unified shape
    return {
      id: r.id,
      name: r.chat_name || r.name || 'User',
      text: r.text || '',
      likes: (r.likes_count ?? r.likes ?? 0),
      createdAt: r.created_at ?? r.createdAt ?? new Date().toISOString()
    };
  }

  function renderMessages(items){
    const normalized = (items||[]).map(normalizeRow);
    els.list.innerHTML = normalized.map(m=>{
      const safeText = escapeHtml(m.text||'');
      const name = escapeHtml(m.name||'User');
      const likeCount = Number(m.likes||0);
      const createdAt = timeStrFrom(m.createdAt);
      return `
        <div class="chat-msg" data-id="${m.id||''}">
          <div class="chat-badge" aria-hidden="true">${avatarOf(name)}</div>
          <div class="chat-bubble">
            <div class="chat-meta"><span class="name">${name}</span> <span class="time">${createdAt}</span></div>
            <div class="chat-text">${safeText}</div>
            <div class="chat-actions">
              <button class="like-btn" data-id="${m.id||''}" type="button" aria-label="Like">👍 <span class="cnt">${likeCount}</span></button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // attach like handlers
    els.list.querySelectorAll('.like-btn').forEach(btn=>{
      btn.addEventListener('click', ()=> likeMessage(btn.dataset.id));
    });
    // scroll to bottom
    els.list.scrollTop = els.list.scrollHeight;
  }

  // ---------- Supabase client init ----------
  async function initChatSupabase(){
    if(chatInitResolved) return;
    try{
      const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm');
      const { createClient } = mod;
      chatSupabase = createClient(CHAT_SUPABASE_URL, CHAT_SUPABASE_ANON_KEY);
      console.log('[BRX] chat supabase initialized');
    }catch(err){
      console.warn('[BRX] chat supabase init failed', err);
      chatSupabase = null;
    } finally {
      chatInitResolved = true;
    }
  }
  const chatInitPromise = initChatSupabase();

  // ---------- Chat name modal helpers ----------
  function showChatNameModal(suggested){
    if(!els.chatNameModal) return Promise.reject('no modal');
    els.chatNameModal.style.display = 'block';
    els.chatNameModal.setAttribute('aria-hidden','false');
    els.chatNameInput.value = suggested || '';
    els.chatNameFeedback.textContent = '';
    els.chatNameInput.focus();

    return new Promise((resolve, reject)=>{
      // cleanup if re-used
      const cleanup = ()=>{
        els.saveChatNameBtn.removeEventListener('click', onSave);
        els.cancelChatNameBtn.removeEventListener('click', onCancel);
        els.chatNameInput.removeEventListener('keydown', onKeyDown);
      };
      async function onSave(){
        const name = (els.chatNameInput.value || '').trim();
        if(!name || name.length < 3){ els.chatNameFeedback.textContent = 'Name must be at least 3 characters'; return; }
        // check uniqueness on chat DB if available
        if(chatSupabase){
          try{
            const { data: exists, error: exErr } = await chatSupabase.from('chat_users').select('id').eq('chat_name', name).limit(1);
            if(exErr){ console.warn('uniqueness check error', exErr); els.chatNameFeedback.textContent = 'Unable to check name uniqueness — try again'; return; }
            if(exists && exists.length > 0){ els.chatNameFeedback.textContent = 'That name is already taken — choose another'; return; }
            // insert record with app_uid
            const { error: insErr } = await chatSupabase.from('chat_users').insert({ app_uid: uid(), chat_name: name });
            if(insErr){ console.warn('insert chat_user failed', insErr); els.chatNameFeedback.textContent = 'Could not save name — try again'; return; }
            // success
            myChatName = name;
            localStorage.setItem(CHAT_NAME_KEY + '_' + uid(), myChatName);
            updateChatNameDisplay();
            closeModal();
            cleanup();
            resolve(name);
            return;
          }catch(e){
            console.warn('chat name save error', e);
            els.chatNameFeedback.textContent = 'Could not contact chat server — try again or continue offline';
            // allow offline fallback
            if(confirm('Chat server unreachable. Use this name locally only?')) {
              myChatName = name;
              localStorage.setItem(CHAT_NAME_KEY + '_' + uid(), myChatName);
              updateChatNameDisplay();
              closeModal();
              cleanup();
              resolve(name);
            }
            return;
          }
        } else {
          // no chat db available — allow local-only name
          myChatName = name;
          localStorage.setItem(CHAT_NAME_KEY + '_' + uid(), myChatName);
          updateChatNameDisplay();
          closeModal();
          cleanup();
          resolve(name);
        }
      }
      function onCancel(){
        closeModal(); cleanup(); reject('cancel');
      }
      function onKeyDown(e){ if(e.key === 'Enter'){ onSave(); } }
      function closeModal(){
        els.chatNameModal.style.display = 'none';
        els.chatNameModal.setAttribute('aria-hidden','true');
      }

      els.saveChatNameBtn.addEventListener('click', onSave);
      els.cancelChatNameBtn.addEventListener('click', onCancel);
      els.chatNameInput.addEventListener('keydown', onKeyDown);
    });
  }

  function updateChatNameDisplay(){
    if(els.myChatName) els.myChatName.textContent = myChatName || '—';
    if(els.changeChatNameBtn){
      // editing chat name is not supported server-side by current RLS (prevent updates).
      // so hide/disable change button to avoid confusion.
      if(myChatName) {
        els.changeChatNameBtn.style.display = 'none';
      } else {
        els.changeChatNameBtn.style.display = '';
      }
    }
  }

  // ---------- ensure chat profile ----------
  async function ensureMyChatProfile(){
    await chatInitPromise;
    if(myChatName) return myChatName;

    // 1) Check localStorage by uid
    const localStored = localStorage.getItem(CHAT_NAME_KEY + '_' + uid());
    if(localStored){
      myChatName = localStored;
      updateChatNameDisplay();
      return myChatName;
    }

    // 2) If chat DB available, try to find by app_uid
    if(chatSupabase){
      try{
        const { data, error } = await chatSupabase.from('chat_users').select('chat_name').eq('app_uid', uid()).maybeSingle();
        if(!error && data && data.chat_name){
          myChatName = data.chat_name;
          localStorage.setItem(CHAT_NAME_KEY + '_' + uid(), myChatName);
          updateChatNameDisplay();
          return myChatName;
        }
      }catch(e){
        console.warn('[BRX] fetch chat_user error', e);
      }
    }

    // 3) Not found — force user to create one (modal)
    const suggested = (uname()||'Learner').replace(/\s+/g,'').slice(0,18) + Math.floor(Math.random()*900+100);
    try{
      const chosen = await showChatNameModal(suggested);
      return chosen;
    }catch(e){
      // user cancelled — generate a local fallback name (non-unique)
      const fallback = suggested + '_' + String(Math.random()).slice(2,6);
      myChatName = fallback;
      localStorage.setItem(CHAT_NAME_KEY + '_' + uid(), myChatName);
      updateChatNameDisplay();
      return myChatName;
    }
  }

  // ---------- fetch messages ----------
  async function fetchMessagesForChannel(ch){
    // prefer server
    if(chatSupabase){
      try{
        const { data, error } = await chatSupabase
          .from('messages')
          .select('*')
          .eq('channel', ch)
          .order('created_at', { ascending: true })
          .limit(200);
        if(error) throw error;
        return data || [];
      }catch(e){
        console.warn('[BRX] fetch messages failed', e);
        return loadLocal(ch);
      }
    }
    // fallback
    return loadLocal(ch);
  }

  // ---------- realtime subscription ----------
  async function subscribe(ch){
    await chatInitPromise;
    channel = ch || 'general';
    els.input.placeholder = `Message ${'#'+channel}…`;

    // unsubscribe previous
    if(realtimeChannel && chatSupabase){
      try{ await chatSupabase.removeChannel(realtimeChannel); }catch(e){ /* ignore */ }
      realtimeChannel = null;
    }

    // initial load
    const items = await fetchMessagesForChannel(channel);
    renderMessages(items);
    els.status.textContent = chatSupabase ? 'Connected to chat server' : 'Offline/local chat';

    // setup realtime if possible
    if(chatSupabase){
      try{
        // create channel object and subscribe to INSERT & UPDATE on messages (for this channel)
        const chName = 'realtime-messages-' + channel;
        let channelObj = chatSupabase
          .channel(chName)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel=eq.${channel}` }, () => {
            // refresh the list (simple and reliable)
            fetchMessagesForChannel(channel).then(data=> renderMessages(data));
          })
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `channel=eq.${channel}` }, () => {
            fetchMessagesForChannel(channel).then(data=> renderMessages(data));
          })
          // also listen to likes table (so likes added update counts)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'likes' }, () => {
            fetchMessagesForChannel(channel).then(data=> renderMessages(data));
          })
          .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'likes' }, () => {
            fetchMessagesForChannel(channel).then(data=> renderMessages(data));
          })
          .subscribe();

        realtimeChannel = channelObj;
      }catch(e){
        console.warn('[BRX] realtime subscription failed', e);
      }
    }
  }

  // ---------- send message ----------
  async function sendMessage(){
    const text = (els.input?.value || '').trim();
    if(!text) return;
    if(profanity.test(text)) { alert('Please be respectful 🙏'); return; }

    // ensure user has a chat name
    await ensureMyChatProfile();

    const payload = {
      app_uid: uid(),
      chat_name: myChatName || uname(),
      channel,
      text
    };

    // try chat DB
    if(chatSupabase){
      try{
        const { error } = await chatSupabase.from('messages').insert(payload);
        if(error) throw error;
        els.input.value = '';
        return;
      }catch(e){
        console.warn('[BRX] send message to chat DB failed', e);
        // fallthrough to local
      }
    }

    // local fallback
    const msg = {
      id: String(Date.now()) + '_' + Math.random().toString(36).slice(2,7),
      app_uid: uid(),
      chat_name: payload.chat_name,
      channel: payload.channel,
      text: payload.text,
      likes: 0,
      createdAt: new Date().toISOString()
    };
    const arr = loadLocal(channel);
    arr.push(msg);
    saveLocal(channel, arr);
    els.input.value = '';
    renderMessages(arr);
  }

  // ---------- like message (toggle) ----------
  async function likeMessage(messageId){
    if(!messageId) return;
    // prefer server
    if(chatSupabase){
      try{
        // check existing like by this app uid
        const { data: existing, error: fetchErr } = await chatSupabase
          .from('likes')
          .select('id')
          .eq('message_id', messageId)
          .eq('app_uid', uid())
          .limit(1);

        if(fetchErr) throw fetchErr;

        if(existing && existing.length){
          // remove like
          await chatSupabase.from('likes').delete().eq('id', existing[0].id);
        } else {
          // add like
          await chatSupabase.from('likes').insert({ message_id: messageId, app_uid: uid() });
        }

        // recompute like_count cached on messages (update cache column)
        const { count } = await chatSupabase
          .from('likes')
          .select('id', { count: 'exact', head: true })
          .eq('message_id', messageId);
        const newCount = (count || 0);
        await chatSupabase.from('messages').update({ likes_count: newCount }).eq('id', messageId);

        // refresh view
        fetchMessagesForChannel(channel).then(data=> renderMessages(data));
        return;
      }catch(e){
        console.warn('[BRX] like via chat supabase failed', e);
        // fall back to local
      }
    }

    // local fallback: increment likes
    const arr = loadLocal(channel);
    const idx = arr.findIndex(x=>x.id === messageId);
    if(idx >= 0){
      arr[idx].likes = (arr[idx].likes || 0) + 1;
      saveLocal(channel, arr);
      renderMessages(arr);
    }
  }

  // ---------- UI wiring ----------
  els.send?.addEventListener('click', ()=>{ playSfx?.('click'); sendMessage(); });
  els.input?.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendMessage(); } });

  els.tabs?.querySelectorAll('.tab').forEach(t=>{
    t.addEventListener('click', ()=>{
      els.tabs.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      subscribe(t.dataset.channel || 'general');
    });
  });

  // Edit chat name button - disabled in current RLS setup (inform user)
  els.changeChatNameBtn?.addEventListener('click', ()=>{
    alert('Changing chat name is not supported yet. If you must change it, contact admin.');
  });

  // menu -> open community handler
  document.querySelector('[data-target="community"]')?.addEventListener('click', async ()=>{
    await ensureMyChatProfile(); // makes sure user has a chat_name
    updateChatNameDisplay();
    subscribe(channel);
    showScreen('community');
  });

  // auto subscribe if community already visible on load
  if(document.getElementById('community')?.classList.contains('active')){
    ensureMyChatProfile().then(()=> { updateChatNameDisplay(); subscribe(channel); });
  }

  // expose for debugging
  window._chatSubscribe = subscribe;

})();

/* ===================== WIRE MENU BUTTONS (already present elsewhere, safe here too) ===================== */
document.querySelectorAll('#profile .menu-btn, #community .menu-btn').forEach(b=>{
  b.addEventListener('click', ()=>{ playSfx?.('click'); showScreen('menu'); });
});
     saveToCloud();
// ===== runtime header-height sync (append to end of script.js) =====
(function syncHeaderHeight(){
  const bar = document.querySelector('.appbar');
  const app = document.querySelector('.app');
  if(!bar || !app) return;

  const update = () => {
    const h = Math.ceil(bar.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--appbar-height', `${h}px`);
    app.style.paddingTop = `calc(${h}px + var(--app-pad))`;
  };

  // initial
  if(document.readyState === 'complete') update();
  else window.addEventListener('load', update);

  // observe changes to header size (chips wrap, device rotate)
  if(window.ResizeObserver){
    try{
      const ro = new ResizeObserver(update);
      ro.observe(bar);
    }catch(e){ window.addEventListener('resize', update, { passive:true }); }
  } else {
    window.addEventListener('resize', update, { passive:true });
    window.addEventListener('orientationchange', () => setTimeout(update, 140));
  }
})();
/* ===================== Maths Tables Module (final fixes: practice scoring + unique questions) ===================== */
(function(){
  const TABLE_COUNT = 40;
  const LOCK_FROM = 15;
  const UNLOCK_COST = 3;
  const PRACTICE_LENGTH = 10;   // numbers 1..10 by default (unique)
  const DEFAULT_TEST_LENGTH = 10;
  const DEFAULT_TEST_TIMER = 60;
  const STORAGE_KEY = 'brx_tables_progress_v1';

  const EMOJIS = [
    "🍎","🍌","🍇","🍓","🍒","🍑","🍉","🍍","🥝","🍊",
    "🍋","🍐","🥭","🍅","🥕","🌽","🍔","🍕","🥪","🍩",
    "🍪","🍰","🍫","🍬","🍭","🍯","🍳","🧂","🥛","☕",
    "🍵","🍷","🍺","🍸","🍹","🍻","🥂","🧁","🥧","🎂"
  ];

  let stateTables = {
    tokens: 0,
    unlocked: [],
    stats: {},
    recentTests: []
  };

  /* ---------- persistence ---------- */
  function loadTablesState(){
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw){
      stateTables.tokens = 0;
      stateTables.unlocked = Array.from({length:LOCK_FROM-1}, (_,i)=>i+1);
      stateTables.stats = {};
      stateTables.recentTests = [];
      saveTablesState();
      return;
    }
    try{
      Object.assign(stateTables, JSON.parse(raw));
      if(!Array.isArray(stateTables.unlocked) || stateTables.unlocked.length === 0){
        stateTables.unlocked = Array.from({length:LOCK_FROM-1}, (_,i)=>i+1);
      }
      if(typeof stateTables.tokens !== 'number') stateTables.tokens = 0;
      if(!stateTables.stats) stateTables.stats = {};
      if(!Array.isArray(stateTables.recentTests)) stateTables.recentTests = [];
    }catch(e){
      console.warn('loadTablesState error', e);
      // reset to defaults on corrupt payload
      stateTables.tokens = 0;
      stateTables.unlocked = Array.from({length:LOCK_FROM-1}, (_,i)=>i+1);
      stateTables.stats = {};
      stateTables.recentTests = [];
      saveTablesState();
    }
  }
  function saveTablesState(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(stateTables)); }catch(e){}
    updateTokensUI();
  }

  /* ---------- UI helpers ---------- */
  function updateTokensUI(){ const el = document.getElementById('ttTokens'); if(el) el.textContent = String(stateTables.tokens || 0); }
  function isUnlocked(n){ return stateTables.unlocked.includes(n) || n < LOCK_FROM; }

  /* ========== sanitizer: remove stray poster / unwrap stray card ========== */
  function isPosterNode(node){
    if(!node || node.nodeType !== 1) return false;
    const cls = node.className || '';
    if(typeof cls === 'string' && (cls.includes('module-illustration') || cls.includes('module-poster') || cls.includes('illustration'))) return true;
    if(node.classList && node.classList.contains('card')){
      if(node.id === 'tableTokensCard') return false;
      const txt = (node.textContent || '').trim();
      if(/Maths\s*Tables|Tables\s*1(?:[–-]40|–40|1-40)/i.test(txt)) return true;
    }
    return false;
  }
  function removePosterElement(el){
    try{
      const wrap = document.getElementById('tablesWrap');
      if(wrap && el.contains(wrap)){
        const parent = el.parentElement;
        if(parent) parent.insertBefore(wrap, el);
        el.remove();
        console.debug('[brx] unwrapped tablesWrap from stray card');
        return;
      }
      el.remove();
      console.debug('[brx] removed poster element from #tables');
    }catch(e){
      console.warn('removePosterElement error', e);
    }
  }
  function sanitizeTablesSection(){
    const sec = document.getElementById('tables'); if(!sec) return;
    // remove obvious illustration selectors
    const ill = sec.querySelectorAll('.module-illustration, .module-poster, .module-illustration-svg, .module-hero');
    ill.forEach(el => { try{ el.remove(); } catch(e){} });

    // unwrap tablesWrap if accidentally wrapped inside a .card
    const wrap = document.getElementById('tablesWrap');
    if(wrap && wrap.parentElement && wrap.parentElement.classList.contains('card') && wrap.parentElement.id !== 'tableTokensCard'){
      const card = wrap.parentElement; const parent = card.parentElement;
      if(parent){ parent.insertBefore(wrap, card); card.remove(); console.debug('[brx] moved #tablesWrap out of .card and removed wrapper'); }
    }

    // remove any .card that looks like the poster
    const cards = Array.from(sec.querySelectorAll('.card'));
    cards.forEach(c=>{
      if(c.id === 'tableTokensCard') return;
      if(isPosterNode(c)) removePosterElement(c);
    });
  }
  function observeAndCleanTables(){
    const sec = document.getElementById('tables'); if(!sec) return;
    const observer = new MutationObserver(muts=>{
      for(const m of muts){
        for(const node of Array.from(m.addedNodes)){
          if(isPosterNode(node)){ removePosterElement(node); continue; }
          if(node.nodeType === 1){
            const cards = node.querySelectorAll ? node.querySelectorAll('.card') : [];
            for(const c of cards){ if(c.id === 'tableTokensCard') continue; if(isPosterNode(c)) removePosterElement(c); }
            const lids = node.querySelectorAll ? node.querySelectorAll('.module-illustration, .module-poster, .module-illustration-svg, .module-hero') : [];
            lids.forEach(el => { try{ el.remove(); } catch(e){} });
            const wrap = document.getElementById('tablesWrap');
            if(wrap && wrap.parentElement && wrap.parentElement.classList.contains('card') && wrap.parentElement.id !== 'tableTokensCard'){
              const card = wrap.parentElement; const parent = card.parentElement;
              if(parent){ parent.insertBefore(wrap, card); card.remove(); console.debug('[brx] observer unwrapped tablesWrap from card'); }
            }
          }
        }
      }
    });
    observer.observe(sec, { childList: true, subtree: true });
  }

  /* ---------- utilities ---------- */
  function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
  // unique multipliers in range 1..maxMultiplier, avoid duplicates within a run
  function uniqueMultipliers(count, maxMultiplier = 10){
    const base = Array.from({length:maxMultiplier}, (_,i)=>i+1);
    shuffle(base);
    if(count <= maxMultiplier) return base.slice(0,count);
    // if count > maxMultiplier (unlikely), append random picks (keeps some variety)
    const out = base.slice(0);
    while(out.length < count) out.push(Math.floor(Math.random()*maxMultiplier)+1);
    return out;
  }

  /* ---------- render main grid ---------- */
  function renderTableGrid(){
    const wrap = document.getElementById('tablesWrap'); if(!wrap) return;
    wrap.innerHTML = '';
    for(let i=1;i<=TABLE_COUNT;i++){
      const btn = document.createElement('button');
      btn.className = 'table-btn card';
      btn.dataset.table = i;
      const emoji = EMOJIS[(i-1) % EMOJIS.length] || '🔢';
      btn.innerHTML = `
        <div class="table-emoji">${emoji}</div>
        <div>
          <div class="table-label">Table ${i}</div>
          <div class="table-sub">Tap to open</div>
        </div>
      `;
      if(!isUnlocked(i)){
        btn.classList.add('locked');
      } else {
        btn.addEventListener('click', ()=> openTableView(i));
      }
      // locked behaviour: single listener handles both locked/unlocked safely
      btn.addEventListener('click', (ev)=>{
        if(!isUnlocked(i)){
          ev.preventDefault();
          promptUnlock(i);
        }
      });
      wrap.appendChild(btn);
    }
  }

  function promptUnlock(tableNum){
    const msg = `Table ${tableNum} is locked.\nUnlock cost: ${UNLOCK_COST} TT tokens.\nYou have ${stateTables.tokens} TT. Unlock?`;
    if(stateTables.tokens >= UNLOCK_COST && confirm(msg)){
      stateTables.tokens -= UNLOCK_COST;
      if(!stateTables.unlocked.includes(tableNum)) stateTables.unlocked.push(tableNum);
      playSfx?.('coin');
      saveTablesState();
      renderTableGrid();
    } else {
      alert("Not enough tokens yet — earn them in Table Tests.");
      playSfx?.('wrong');
    }
  }

  /* ---------- routing between local screens ---------- */
  function showScreenLocal(id){
    const ids = ['tables','tableView','practiceView','testView','tableProgress','tableHelp','tableReport'];
    ids.forEach(x=>{
      const el = document.getElementById(x);
      if(!el) return;
      el.classList.toggle('active', x === id);
      el.setAttribute('aria-hidden', x===id ? 'false' : 'true');
    });
    try{ if(typeof showScreen === 'function' && id === 'tables') showScreen('tables'); } catch(e){}
  }

  /* ---------- table hub (open table view) ---------- */
  let activeTable = null;
  function openTableView(n){
    activeTable = Number(n);
    const title = document.getElementById('tableViewTitle');
    if(title) title.textContent = `Table ${n}`;
    const list = document.getElementById('tableList');
    if(list){
      list.innerHTML = '';
      for(let i=1;i<=10;i++){
        const row = document.createElement('div');
        row.className = 'tiny';
        row.textContent = `${n} × ${i} = ${n*i}`;
        list.appendChild(row);
      }
    }

    // clear any interactive area
    const ia = document.getElementById('tableInteractive');
    if(ia) ia.innerHTML = '';

    // wire page-opening buttons
    const pbtn = document.getElementById('practiceBtn');
    const tbtn = document.getElementById('testBtn');
    if(pbtn) pbtn.onclick = ()=> openPracticeView(n);
    if(tbtn) tbtn.onclick = ()=> openTestView(n);

    showScreenLocal('tableView');

    // focus and scroll to top (per your earlier request)
    try{ const el = document.querySelector('#tableInteractive input, #tableInteractive button'); if(el) el.focus(); }catch(e){}
    try{ window.scrollTo({ top: 0, behavior: 'smooth' }); }catch(e){ window.scrollTo(0,0); }
  }

  /* ---------- PRACTICE flow (no mistakes mode) ---------- */
  let practiceState = null;
  let practiceHintTimer = null;

  function openPracticeView(tableNum){
    stopAllTimers();
    activeTable = Number(tableNum);
    const span = document.getElementById('practiceTableNum'); if(span) span.textContent = String(activeTable);
    // wire practice mode buttons (MCQ & Input)
    document.getElementById('practiceMCQBtn')?.addEventListener('click', ()=> startPractice(activeTable, 'mcq'));
    document.getElementById('practiceInputBtn')?.addEventListener('click', ()=> startPractice(activeTable, 'input'));
    showScreenLocal('practiceView');
    // auto-start friendly input mode
    startPractice(activeTable, 'input');
    try{ window.scrollTo({ top: 0, behavior: 'smooth' }); }catch(e){ window.scrollTo(0,0); }
  }

  function startPractice(table, mode='input'){
    stopAllTimers();
    const area = document.getElementById('practiceContent');
    if(!area) return;
    area.innerHTML = '';
    practiceState = {
      table: Number(table),
      mode,
      index: 0,
      answers: [],   // will store objects { multiplier, chosen, correct, correctFlag }
      qList: []
    };

    if(mode === 'input'){
      // use unique multipliers 1..10 (no repeats)
      const mults = uniqueMultipliers(PRACTICE_LENGTH);
      practiceState.qList = mults.map(m => ({ multiplier: m, correct: table * m }));
      practiceState.index = 0;
    } else {
      // MCQ mode
      const mults = uniqueMultipliers(PRACTICE_LENGTH);
      practiceState.qList = mults.map(multiplier => {
        const correct = table * multiplier;
        const distractors = new Set();
        while(distractors.size < 3){
          let delta = Math.floor(Math.random()*7) - 3 || 1;
          let cand = correct + delta;
          if(cand <= 0 || cand === correct) cand = correct + (delta * 2 || 2);
          distractors.add(cand);
        }
        return { multiplier, correct, opts: shuffle([correct, ...Array.from(distractors)]) };
      });
      practiceState.index = 0;
    }

    renderPracticeQuestion();
  }

  function clearPracticeHint(){ if(practiceHintTimer){ clearTimeout(practiceHintTimer); practiceHintTimer = null; } }

  function renderPracticeQuestion(){
    clearPracticeHint();
    const area = document.getElementById('practiceContent');
    if(!area || !practiceState) return;
    area.innerHTML = '';

    // finished
    if(practiceState.index >= practiceState.qList.length){
      const correct = practiceState.answers.filter(a => a.correctFlag).length;
      const wrong = practiceState.answers.length - correct;
      const percent = practiceState.answers.length ? Math.round((correct / practiceState.answers.length) * 100) : 0;
      // save stats (do NOT save lastResponses for practice - we removed mistakes mode)
      recordPracticeResult(practiceState.table, correct, wrong, percent);
      // show report
      renderReport({
        table: practiceState.table,
        mode: 'Practice',
        questions: practiceState.answers,
        correct, wrong, percent, tokensEarned: 0
      });
      practiceState = null;
      return;
    }

    const qObj = practiceState.qList[practiceState.index];
    const qNum = practiceState.index + 1;

    if(practiceState.mode === 'input'){
      // Input UI
      const label = document.createElement('div');
      label.innerHTML = `<div style="font-size:18px;font-weight:800;margin-bottom:8px">Question ${qNum} of ${practiceState.qList.length}</div>`;

      const question = document.createElement('div');
      question.className = 'card';
      question.style.display = 'flex';
      question.style.gap = '12px';
      question.style.alignItems = 'center';
      question.innerHTML = `<div style="font-size:20px;font-weight:800">${practiceState.table} × ${qObj.multiplier} =</div>
                            <input id="practiceInputFld" type="number" inputmode="numeric" style="flex:1;padding:8px;border-radius:8px;border:1px solid #eee" />`;

      const submit = document.createElement('button');
      submit.className = 'btn btn-primary';
      submit.textContent = 'Submit';
      submit.style.marginTop = '8px';

      area.appendChild(label);
      area.appendChild(question);
      area.appendChild(submit);

      const input = document.getElementById('practiceInputFld');
      if(input) input.focus();

      // hint timer: 10s
      practiceHintTimer = setTimeout(()=>{
        const ans = qObj.correct;
        const hint = document.createElement('div');
        hint.className = 'tiny muted';
        hint.style.marginTop = '8px';
        hint.textContent = `Hint: first digit is ${String(ans)[0]}.`;
        area.appendChild(hint);
        setTimeout(()=> {
          if(!practiceState) return;
          const full = document.createElement('div');
          full.style.marginTop = '6px';
          full.innerHTML = `<strong>Answer:</strong> ${ans}`;
          area.appendChild(full);
        }, 1200);
      }, 10000);

      function submitAnswer(){
        clearPracticeHint();
        const raw = input ? input.value : '';
        const val = raw === '' ? NaN : Number(raw);
        const ok = (val === qObj.correct);
        practiceState.answers.push({
          multiplier: qObj.multiplier,
          chosen: val,
          correct: qObj.correct,
          correctFlag: !!ok
        });
        practiceState.index++;
        playSfx?.(ok ? 'correct' : 'wrong');
        renderPracticeQuestion();
      }

      submit.onclick = submitAnswer;
      if(input){
        input.addEventListener('keydown', (e)=>{
          if(e.key === 'Enter') submitAnswer();
        });
      }
      return;
    }

    // MCQ UI
    const card = document.createElement('div');
    card.innerHTML = `<div style="font-weight:800;font-size:18px">Question ${qNum} of ${practiceState.qList.length}</div>
                      <div style="margin-top:8px;font-size:20px"><strong>${practiceState.table} × ${qObj.multiplier} = ?</strong></div>`;

    const optsWrap = document.createElement('div');
    optsWrap.style.marginTop = '12px';
    optsWrap.style.display = 'grid';
    optsWrap.style.gridTemplateColumns = '1fr 1fr';
    optsWrap.style.gap = '8px';

    let answered = false;
    qObj.opts.forEach(opt=>{
      const b = document.createElement('button');
      b.className = 'btn btn-ghost';
      b.style.padding = '10px';
      b.textContent = opt;
      b.onclick = ()=>{
        if(answered) return;
        answered = true;
        const isCorrect = (opt === qObj.correct);
        practiceState.answers.push({
          multiplier: qObj.multiplier,
          chosen: opt,
          correct: qObj.correct,
          correctFlag: !!isCorrect
        });
        practiceState.index++;
        playSfx?.(isCorrect ? 'correct' : 'wrong');
        renderPracticeQuestion();
      };
      optsWrap.appendChild(b);
    });

    // hint after 10s: lightly highlight
    practiceHintTimer = setTimeout(()=>{
      const buttons = optsWrap.querySelectorAll('button');
      buttons.forEach(btn=>{
        if(Number(btn.textContent) === qObj.correct){
          btn.classList.add('btn-primary');
        } else {
          btn.style.opacity = '0.6';
        }
      });
      const hint = document.createElement('div');
      hint.className = 'tiny muted';
      hint.style.marginTop = '8px';
      hint.textContent = `Hint: answer is ${qObj.correct}`;
      area.appendChild(hint);
    }, 10000);

    area.appendChild(card);
    area.appendChild(optsWrap);
  }

  function recordPracticeResult(table, correct, wrong, percent){
    const t = String(table);
    if(!stateTables.stats[t]) stateTables.stats[t] = { practiceCount:0, testCount:0, bestScore:0, recentTests:[] };
    stateTables.stats[t].practiceCount = (stateTables.stats[t].practiceCount || 0) + 1;
    stateTables.stats[t].lastPractice = { date: (new Date()).toISOString(), correct, wrong, percent };
    saveTablesState();
  }

  /* ---------- TEST Flow (MCQ timed) ---------- */
  let testState = null;
  let testTimerInterval = null;

  function openTestView(tableNum){
    stopAllTimers();
    activeTable = Number(tableNum);
    const span = document.getElementById('testTableNum'); if(span) span.textContent = String(activeTable);
    const top = document.getElementById('testTimerTop'); if(top) top.textContent = '--';
    const startBtn = document.getElementById('startTestBtn');
    if(startBtn){
      startBtn.onclick = ()=> {
        const qCount = Number(document.getElementById('testQuestionCount')?.value) || DEFAULT_TEST_LENGTH;
        const timer = Number(document.getElementById('testTimerSelect')?.value) || DEFAULT_TEST_TIMER;
        startTest(activeTable, qCount, timer);
      };
    }
    showScreenLocal('testView');
    try{ window.scrollTo({ top: 0, behavior: 'smooth' }); }catch(e){ window.scrollTo(0,0); }
  }

  function startTest(table, qCount = DEFAULT_TEST_LENGTH, timerSeconds = DEFAULT_TEST_TIMER){
    stopAllTimers();
    const area = document.getElementById('testContent');
    if(!area) return;
    area.innerHTML = '';

    const multipliers = uniqueMultipliers(qCount);
    const qList = multipliers.map(multiplier => {
      const correct = table * multiplier;
      const distractors = new Set();
      while(distractors.size < 3){
        let delta = Math.floor(Math.random()*7) - 3 || 1;
        let cand = correct + delta;
        if(cand <= 0 || cand === correct) cand = correct + delta * 2;
        distractors.add(cand);
      }
      return { multiplier, correct, opts: shuffle([correct, ...Array.from(distractors)]) };
    });

    testState = {
      table: Number(table),
      questions: qList,
      index: 0,
      correct: 0,
      wrong: 0,
      responses: [], // store { multiplier, chosen, correct, correctFlag }
      timeLeft: timerSeconds,
      finished: false
    };

    const top = document.getElementById('testTimerTop'); if(top) top.textContent = `${testState.timeLeft}s`;
    renderTestQuestion();
    startTestTimer();
  }

  function renderTestQuestion(){
    const area = document.getElementById('testContent');
    if(!area || !testState) return;
    area.innerHTML = '';

    if(testState.index >= testState.questions.length || testState.timeLeft <= 0){
      finishTest();
      return;
    }

    const qObj = testState.questions[testState.index];
    const qNum = testState.index + 1;
    const card = document.createElement('div');
    card.innerHTML = `<div style="font-weight:800;font-size:18px">Question ${qNum} of ${testState.questions.length}</div>
                      <div style="margin-top:8px;font-size:20px"><strong>${testState.table} × ${qObj.multiplier} = ?</strong></div>`;

    const optsWrap = document.createElement('div');
    optsWrap.style.marginTop = '12px';
    optsWrap.style.display = 'grid';
    optsWrap.style.gridTemplateColumns = '1fr 1fr';
    optsWrap.style.gap = '8px';

    qObj.opts.forEach(opt => {
      const b = document.createElement('button');
      b.className = 'btn btn-ghost';
      b.style.padding = '10px';
      b.textContent = opt;
      b.onclick = () => {
        const isCorrect = (opt === qObj.correct);
        if(isCorrect) { testState.correct++; playSfx?.('correct'); }
        else { testState.wrong++; playSfx?.('wrong'); }
        testState.responses.push({ multiplier: qObj.multiplier, chosen: opt, correct: qObj.correct, correctFlag: !!isCorrect });
        testState.index++;
        const top = document.getElementById('testTimerTop'); if(top) top.textContent = `${testState.timeLeft}s`;
        renderTestQuestion();
      };
      optsWrap.appendChild(b);
    });

    const timerBar = document.createElement('div');
    timerBar.style.marginTop = '12px';
    timerBar.innerHTML = `<div class="tiny muted">Time left: <strong id="testTimerDisplay">${testState.timeLeft}s</strong></div>`;

    area.appendChild(card);
    area.appendChild(optsWrap);
    area.appendChild(timerBar);
  }

  function startTestTimer(){
    clearTestTimer();
    testTimerInterval = setInterval(()=>{
      if(!testState) return clearTestTimer();
      testState.timeLeft--;
      const d1 = document.getElementById('testTimerDisplay');
      const d2 = document.getElementById('testTimerTop');
      if(d1) d1.textContent = `${testState.timeLeft}s`;
      if(d2) d2.textContent = `${testState.timeLeft}s`;
      if(testState.timeLeft <= 0){
        clearTestTimer();
        const area = document.getElementById('testContent');
        if(area) { area.classList.add('brx-timeout'); setTimeout(()=> area.classList.remove('brx-timeout'), 800); }
        finishTest();
      }
    }, 1000);
  }
  function clearTestTimer(){ if(testTimerInterval){ clearInterval(testTimerInterval); testTimerInterval = null; } }

  function finishTest(){
    if(!testState) return;
    clearTestTimer();
    const total = testState.questions.length;
    const correct = testState.correct;
    const wrong = testState.wrong + (total - testState.responses.length);
    const percent = total ? Math.round((correct / total) * 100) : 0;
    const tokensEarned = correct; // 1 token per correct answer

    // persist lastResponses for tests (kept for report review)
    const t = String(testState.table);
    if(!stateTables.stats[t]) stateTables.stats[t] = { practiceCount:0, testCount:0, bestScore:0, recentTests:[], lastResponses: [] };
    stateTables.stats[t].lastResponses = testState.responses.slice();

    recordTestResult(testState.table, correct, wrong, percent, tokensEarned, testState.responses);

    renderReport({
      table: testState.table,
      mode: 'Test',
      questions: testState.responses,
      correct, wrong, percent, tokensEarned
    });

    testState = null;
  }

  function recordTestResult(table, correct, wrong, percent, tokensEarned, responses){
    const t = String(table);
    if(!stateTables.stats[t]) stateTables.stats[t] = { practiceCount:0, testCount:0, bestScore:0, recentTests:[], lastResponses: [] };
    stateTables.stats[t].testCount = (stateTables.stats[t].testCount || 0) + 1;
    stateTables.stats[t].recentTests = stateTables.stats[t].recentTests || [];
    stateTables.stats[t].recentTests.unshift({ date: (new Date()).toISOString(), correct, wrong, percent, tokensEarned });
    if(stateTables.stats[t].recentTests.length > 10) stateTables.stats[t].recentTests.length = 10;
    if(percent > (stateTables.stats[t].bestScore || 0)) stateTables.stats[t].bestScore = percent;

    stateTables.recentTests.unshift({ table, date: (new Date()).toISOString(), percent, correct, wrong, tokensEarned });
    if(stateTables.recentTests.length > 20) stateTables.recentTests.length = 20;

    stateTables.tokens = (stateTables.tokens || 0) + (tokensEarned || 0);
    saveTablesState();

    if(tokensEarned > 0 && typeof launchConfetti === 'function') launchConfetti();
  }

  /* ---------- render Report (both Practice & Test) ---------- */
  function renderReport({table, mode, questions, correct, wrong, percent, tokensEarned}){
    const card = document.getElementById('reportCard'); if(!card) return;
    card.innerHTML = '';

    const header = document.createElement('div');
    header.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h3>Table ${table} — ${mode} Result</h3>
          <div class="tiny muted">Completed: ${new Date().toLocaleString()}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:20px;font-weight:800">${percent}%</div>
          <div class="tiny muted">Score</div>
        </div>
      </div>
    `;

    const summary = document.createElement('div');
    summary.style.marginTop = '12px';
    summary.innerHTML = `<div><strong>Correct:</strong> ${correct}</div>
                         <div><strong>Wrong:</strong> ${wrong}</div>
                         <div><strong>Tokens earned:</strong> ${tokensEarned}</div>`;

    const stat = stateTables.stats[String(table)] || {};
    const previousBest = stat.bestScore || 0;
    const improvement = percent - previousBest;
    const impLine = document.createElement('div');
    impLine.style.marginTop = '8px';
    impLine.innerHTML = `<div><strong>Previous best:</strong> ${previousBest}%</div>
                         <div><strong>Improvement:</strong> ${improvement >= 0 ? '+'+improvement : improvement}%</div>`;

    const iq = Math.round(100 + (percent - 50) * 0.6);
    const iqLine = document.createElement('div');
    iqLine.style.marginTop = '8px';
    iqLine.innerHTML = `<div><strong>IQ (est.):</strong> ${iq}</div>`;

    card.appendChild(header);
    card.appendChild(summary);
    card.appendChild(impLine);
    card.appendChild(iqLine);

    // Details — show expected & user answer and mark correct/incorrect visually
    if(Array.isArray(questions) && questions.length){
      const det = document.createElement('div');
      det.style.marginTop = '12px';
      det.innerHTML = '<h4>Details</h4>';
      questions.forEach((q)=>{
        // q expected shape: { multiplier, chosen, correct, correctFlag }
        const row = document.createElement('div');
        row.className = 'row';
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.padding = '8px';
        row.style.borderBottom = '1px solid #f0f0f0';

        const expectedText = q.multiplier ? `${table} × ${q.multiplier} = ${q.correct}` : '';
        const userAns = (q.chosen === undefined || Number.isNaN(q.chosen)) ? '—' : String(q.chosen);
        const statusMark = q.correctFlag ? '✅' : '❌';

        row.innerHTML = `<div>${expectedText}</div><div style="display:flex;gap:8px;align-items:center"><div>You: ${userAns}</div><div>${statusMark}</div></div>`;
        det.appendChild(row);
      });
      card.appendChild(det);
    }

    // Back button
    const backWrap = document.createElement('div');
    backWrap.style.marginTop = '12px';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Back to Table';
    btn.onclick = ()=> { openTableView(table); showScreenLocal('tableView'); };
    backWrap.appendChild(btn);
    card.appendChild(backWrap);

    showScreenLocal('tableReport');
  }

  /* ---------- Progress & Help ---------- */
  function renderProgress(){
    const card = document.getElementById('progressCard'); if(!card) return;
    card.innerHTML = '';
    const practicedTables = Object.keys(stateTables.stats || {}).filter(t => (stateTables.stats[t].practiceCount || stateTables.stats[t].testCount || stateTables.stats[t].bestScore)).length;
    const totalTests = stateTables.recentTests.length;
    const totalTokens = stateTables.tokens;
    const overallBestScores = Object.values(stateTables.stats || {}).map(s=>s.bestScore||0);
    const avgBest = overallBestScores.length ? Math.round(overallBestScores.reduce((a,b)=>a+b,0)/overallBestScores.length) : 0;

    card.innerHTML = `
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div class="stat" style="flex:1;padding:12px;border-radius:10px;background:rgba(0,0,0,0.02)">
          <div class="stat-num">${practicedTables}</div>
          <div class="stat-lbl">Tables practiced</div>
        </div>
        <div class="stat" style="flex:1;padding:12px;border-radius:10px;background:rgba(0,0,0,0.02)">
          <div class="stat-num">${totalTests}</div>
          <div class="stat-lbl">Recent tests</div>
        </div>
        <div class="stat" style="flex:1;padding:12px;border-radius:10px;background:rgba(0,0,0,0.02)">
          <div class="stat-num">${totalTokens}</div>
          <div class="stat-lbl">TT Tokens</div>
        </div>
        <div class="stat" style="flex:1;padding:12px;border-radius:10px;background:rgba(0,0,0,0.02)">
          <div class="stat-num">${avgBest}%</div>
          <div class="stat-lbl">Avg best score</div>
        </div>
      </div>
    `;

    const recentWrap = document.createElement('div');
    recentWrap.style.marginTop = '12px';
    recentWrap.innerHTML = '<h4>Recent Tests</h4>';
    const list = document.createElement('div');
    list.style.display = 'grid';
    list.style.gap = '8px';
    stateTables.recentTests.slice(0,8).forEach(r=>{
      const item = document.createElement('div');
      item.className = 'card';
      item.style.display = 'flex';
      item.style.justifyContent = 'space-between';
      item.innerHTML = `<div>Table ${r.table} — ${new Date(r.date).toLocaleString()}</div>
                        <div style="text-align:right">${r.percent}% • ${r.correct}/${r.correct+r.wrong}</div>`;
      list.appendChild(item);
    });
    recentWrap.appendChild(list);
    card.appendChild(recentWrap);

    showScreenLocal('tableProgress');
  }
  function showHelp(){ showScreenLocal('tableHelp'); }

  /* ---------- confetti ---------- */
  function launchConfetti(){
    const colors = ['#ff5c5c','#ffb85c','#ffd86b','#6be3ff','#7bffb8','#b58cff'];
    for(let i=0;i<40;i++){
      const el = document.createElement('div');
      el.className = 'brx-confetti-piece';
      el.style.background = colors[i % colors.length];
      el.style.left = Math.random()*100 + 'vw';
      el.style.top = (Math.random()*-10) + 'vh';
      el.style.transform = `rotate(${Math.random()*360}deg)`;
      document.body.appendChild(el);
      setTimeout(()=> el.remove(), 1600);
    }
  }

  /* ---------- helpers: timers/stop ---------- */
  function stopAllTimers(){ clearPracticeHint(); clearTestTimer(); }

  /* ---------- init ---------- */
  function initTablesModule(){
    loadTablesState();
    try{ sanitizeTablesSection(); observeAndCleanTables(); }catch(e){ console.debug('sanitize error', e); }
    renderTableGrid();
    updateTokensUI();

    document.getElementById('tablesMenuBtn')?.addEventListener('click', ()=> { showScreen('menu'); playSfx?.('nav'); });

    document.getElementById('tableBackBtn')?.addEventListener('click', ()=> { showScreenLocal('tables'); playSfx?.('nav'); });
    document.getElementById('practiceBackBtn')?.addEventListener('click', ()=> { stopAllTimers(); showScreenLocal('tableView'); });
    document.getElementById('testBackBtn')?.addEventListener('click', ()=> { stopAllTimers(); showScreenLocal('tableView'); });

    document.getElementById('progressBtn')?.addEventListener('click', ()=> { renderProgress(); playSfx?.('nav'); });
    document.getElementById('helpBtn')?.addEventListener('click', ()=> { showHelp(); playSfx?.('nav'); });

    document.getElementById('progressBackBtn')?.addEventListener('click', ()=> { showScreenLocal('tables'); });
    document.getElementById('helpBackBtn')?.addEventListener('click', ()=> { showScreenLocal('tables'); });
    document.getElementById('reportBackBtn')?.addEventListener('click', ()=> { showScreenLocal('tables'); });
  }

  // expose for debugging if needed
  window.brxTables = {
    init: initTablesModule,
    launchConfetti
  };

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', initTablesModule, {once:true});
  } else {
    initTablesModule();
  }
})();
/* ===== Fullscreen reminder: show after FIRST user button touch; re-show 5min after close ===== */
(function(){
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  let fsTimer = null;
  let interactionSeen = false; // becomes true after user taps any button-like control
  let modal = null;

  function isFullscreen(){
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
  }

  function showTip(){
    if(isFullscreen()) return;
    if(document.visibilityState === 'hidden') return;
    if(!modal) return;
    if(!modal.classList.contains('hidden')) return;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden','false');
    try{ document.getElementById('goFullscreenBtn')?.focus(); }catch(e){}
    try{ if(typeof playSfx === 'function') playSfx('pop'); }catch(e){}
  }

  function hideTip(schedule = true){
    if(!modal) return;
    if(modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden','true');
    if(schedule) scheduleReshow();
  }

  function scheduleReshow(){
    clearReshow();
    fsTimer = setTimeout(() => {
      if(!isFullscreen() && document.visibilityState === 'visible') {
        showTip();
      }
    }, INTERVAL_MS);
  }

  function clearReshow(){
    if(fsTimer){ clearTimeout(fsTimer); fsTimer = null; }
  }

  // Called when user taps a "button-like" control. Only shows the tip on the FIRST such interaction.
  function onUserTouch(ev){
    try{
      // Ignore touches that happen inside the modal itself
      if(ev.target.closest && ev.target.closest('#fullscreenTip')) return;

      // Consider an element "button-like" if it or an ancestor matches:
      // button, [role="button"], .btn, .nav, .menu-btn, .card.nav
      const match = ev.target.closest && ev.target.closest('button, [role="button"], .btn, .nav, .menu-btn, .card.nav, .grid button');
      if(!match) return;

      if(isFullscreen()) return; // already fullscreen → nothing to do

      // mark interaction & show modal (defer slightly so original click continues)
      if(!interactionSeen){
        interactionSeen = true;
        setTimeout(()=>{ showTip(); }, 60);
      }
    }catch(e){}
  }

  // Wire up modal buttons + lifecycle
  function attachHandlers(){
    document.addEventListener('pointerdown', onUserTouch, { passive:true }); // catches touch & mouse
    // Handle clicks on modal controls
    document.addEventListener('click', (ev) => {
      const t = ev.target;
      if(!t) return;
      if(t.id === 'closeFullscreenTip' || t.id === 'dismissFullscreenBtn'){
        // user explicitly closed — re-show after 5 minutes
        hideTip(true);
      } else if(t.id === 'goFullscreenBtn'){
        // request fullscreen (user gesture) — stop reminders
        hideTip(false);
        clearReshow();
        const el = document.documentElement;
        if(el.requestFullscreen) el.requestFullscreen().catch(()=>{});
        else if(el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        else if(el.msRequestFullscreen) el.msRequestFullscreen();
      }
    }, { passive:true });

    // When fullscreen changes, hide tip and stop reminders; when exiting fullscreen reset so next touch shows again.
    function onFsChange(){
      if(isFullscreen()){
        clearReshow();
        hideTip(false);
        interactionSeen = false;
      } else {
        // user left fullscreen — allow next button touch to re-trigger the tip
        interactionSeen = false;
      }
    }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    document.addEventListener('mozfullscreenchange', onFsChange);

    // Stop reminders on logout
    const logoutBtn = document.getElementById('logoutBtn');
    if(logoutBtn){
      logoutBtn.addEventListener('click', () => {
        clearReshow();
        hideTip(false);
        interactionSeen = false;
      });
    }
  }

  function init(){
    modal = document.getElementById('fullscreenTip');
    if(!modal){
      // modal not found — log warning but keep script alive.
      console.warn('[BRX] fullscreenTip modal not found. Add the HTML snippet to index.html (or ignore this warning).');
    }
    attachHandlers();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // expose for debugging / manual control
  window.__brxFsTip = {
    show: showTip,
    hide: hideTip,
    scheduleReshow,
    clearReshow,
    isFullscreen
  };
})();
// === Header helpers: Theme toggle (persisted) + Voice toggle ===
document.addEventListener('DOMContentLoaded', function () {
  const themeBtn = document.getElementById('themeToggle');
  const voiceBtn = document.getElementById('voiceToggle');

  // -------- THEME (force Light on every load; no saved theme) ----------
function getThemeBtn() { return document.getElementById('themeToggle'); }

function ensureThemeBtn() {
  if (getThemeBtn()) return;
  const container = document.querySelector('.appbar-actions');
  if (!container) return;
  const btn = document.createElement('button');
  btn.id = 'themeToggle';
  btn.type = 'button';
  btn.className = 'chip chip-outline';
  btn.title = 'Toggle theme';
  btn.setAttribute('aria-pressed', 'false');
  container.appendChild(btn);
}

/**
 * Apply theme immediately (no persistence).
 * mode: 'light' | 'dark'
 */
function applyTheme(mode) {
  const btn = getThemeBtn();
  const nextLabel = mode === 'dark' ? 'Light' : 'Dark';
  const nextIcon  = mode === 'dark' ? '☀️' : '🌙';

  if (mode === 'dark') {
    document.documentElement.classList.add('brx-dark');
    btn?.setAttribute('aria-pressed', 'true');
  } else {
    document.documentElement.classList.remove('brx-dark');
    btn?.setAttribute('aria-pressed', 'false');
  }

  if (btn) {
    btn.innerHTML = `<span class="chip-icon" aria-hidden="true">${nextIcon}</span><span class="chip-label">${nextLabel}</span>`;
  }
}

// ensure button exists (if your header markup adds it earlier, this is harmless)
ensureThemeBtn();

// Always start in Light on every load/refresh
applyTheme('light');

// Toggle handler: switch theme for this session only (do NOT save to localStorage)
getThemeBtn()?.addEventListener('click', () => {
  const isDark = document.documentElement.classList.contains('brx-dark');
  const newMode = isDark ? 'light' : 'dark';
  applyTheme(newMode);
  try { window.playSfx && window.playSfx('toggle'); } catch (e) { /* ignore sfx errors */ }
});


  // -------- VOICE ----------
  function updateVoiceLabel() {
    if (!voiceBtn) return;
    if (typeof window.state !== 'undefined') {
      // use in-app state if present
      const isOn = !!window.state.voiceOn;
      voiceBtn.innerHTML = `<span class="chip-icon" aria-hidden="true">${isOn ? '🔊' : '🔈'}</span><span class="chip-label">${isOn ? 'Voice ON' : 'Voice OFF'}</span>`;
      voiceBtn.setAttribute('aria-pressed', isOn);
    } else {
      // fallback to localStorage
      const vOn = localStorage.getItem('brx_voice') !== 'off';
      voiceBtn.innerHTML = `<span class="chip-icon" aria-hidden="true">${vOn ? '🔊' : '🔈'}</span><span class="chip-label">${vOn ? 'Voice ON' : 'Voice OFF'}</span>`;
      voiceBtn.setAttribute('aria-pressed', vOn);
    }
  }
  updateVoiceLabel();

  if (voiceBtn) {
    voiceBtn.addEventListener('click', function () {
      if (typeof window.state !== 'undefined') {
        window.state.voiceOn = !window.state.voiceOn;
      } else {
        const cur = localStorage.getItem('brx_voice') !== 'off';
        localStorage.setItem('brx_voice', cur ? 'off' : 'on');
      }
      updateVoiceLabel();
      try { window.playSfx && window.playSfx('toggle'); } catch (e) { /* ignore */ }
    });
  }
});

