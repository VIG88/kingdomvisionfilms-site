/* ═══════════════════════════════════════════════════════════════
   KINGDOM VISION FILMS — script.js
   Cinematic Engine v16 — Always-Load Fallback Edition

   LOADING FALLBACK STRATEGY:
   - Intro video: 3 s hard timeout → skip to homepage immediately
   - BG video: error / stall / canplay-timeout → fall back to static
     KVF image (kvf-logo-4k.png) so there is NEVER a black screen
   - All asset paths are relative (./assets/…) — no external deps

   SEAMLESS LOOP STRATEGY:
   Both bg-video-a and bg-video-b start playing from t=0 together.
   Because they play the same content in sync, both videos show the
   same frame at the same time — the crossfade blends identical
   frames, making every transition completely invisible.

   SWAP SEQUENCE (1.5 s before active video ends):
     1. CSS: active fades 1→0, idle fades 0→1 over 1.5 s
        (both at the same currentTime → blend is imperceptible)
     2. Role labels swap so next cycle is ready
     3. AFTER the CSS transition ends, seek the now-hidden outgoing
        video back to t=0 and let it play silently from there
     4. By next swap time (~5.5 s later) it has advanced to ~5.5 s —
        exactly matching activeVid — giving another perfect blend
   NO seek ever happens while a video is visible. Zero glitches.

   INTRO → BG CROSSFADE:
     Intro plays once; at 9.3 s both opacity transitions fire
     simultaneously (intro 1→0, bg-wrap 0→1).

   SOUND STATE:
     isMuted shared across all three videos, applied on every toggle.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── DOM references ─────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  var introScreen  = $('intro-screen');
  var introVideo   = $('intro-video');
  var introLoader  = $('intro-loader');
  var bgVideoWrap  = $('bg-video-wrap');
  var bgVideoA     = $('bg-video-a');
  var bgVideoB     = $('bg-video-b');
  var soundToggle  = $('sound-toggle');
  var iconMuted    = soundToggle ? soundToggle.querySelector('.icon-muted')   : null;
  var iconUnmuted  = soundToggle ? soundToggle.querySelector('.icon-unmuted') : null;
  var grainCanvas  = $('grain-canvas');
  var logoGlow     = $('logo-glow');
  var overlay      = $('cinematic-overlay');
  var vignette     = $('vignette');
  var pCanvas      = $('particle-canvas');
  var smokes       = document.querySelectorAll('.smoke');
  var siteHeader   = $('site-header');
  var words        = document.querySelectorAll('.word');
  var scrollCue    = $('scroll-cue');
  var navToggle    = $('nav-toggle');
  var mainNav      = $('main-nav');
  var heroTagline  = $('hero-tagline');

  /* ── Timing constants ───────────────────────────────────────────
     Intro:    11.037 s total. Crossfade to homepage starts at 9.3 s.
     BG loop:   7.037 s total. Dual-video swap starts at 5.537 s
                (= 7.037 - LOOP_XFADE_SEC). Transition 1.5 s.
  ─────────────────────────────────────────────────────────────── */
  var INTRO_FADE_SEC   = 9.3;
  var INTRO_XFADE_MS   = 1500;
  var STALL_TIMEOUT_MS = 3000;   /* 3 s hard timeout — skip intro  */
  var BG_CANPLAY_MS    = 5000;   /* 5 s to wait for bg canplay     */

  var BG_DURATION_SEC  = 7.037;  /* exact ffprobe duration         */
  var LOOP_XFADE_SEC   = 1.5;    /* seconds before end — start swap */
  var LOOP_XFADE_MS    = 1500;   /* must match CSS transition      */

  var transitionStarted = false;
  var stallTimer        = null;
  var videoStarted      = false;
  var isMuted           = true;

  /* ── Dual-video loop state ──────────────────────────────────── */
  var activeVid  = bgVideoA;   /* currently visible (opacity:1)   */
  var idleVid    = bgVideoB;   /* warm/playing under opacity:0     */
  var swapping   = false;      /* guard — only one swap at a time  */
  var loopRafId  = null;

  /* ── BG fallback state ──────────────────────────────────────── */
  var bgFallbackApplied = false;
  var bgCanplayTimer    = null;


  /* ══════════════════════════════════════════════════════════════
     BG VIDEO FALLBACK
     If neither bg video fires canplay within BG_CANPLAY_MS, or if
     both error out, hide the video wrap and show the static 4K
     logo image instead — the page is NEVER left with a black bg.
  ══════════════════════════════════════════════════════════════ */
  function applyBgFallback() {
    if (bgFallbackApplied) return;
    bgFallbackApplied = true;

    /* Stop any pending canplay timer */
    clearTimeout(bgCanplayTimer);

    /* Pause and detach video sources so they stop draining bandwidth */
    try { bgVideoA.pause(); bgVideoA.src = ''; bgVideoA.load(); } catch (e) {}
    try { bgVideoB.pause(); bgVideoB.src = ''; bgVideoB.load(); } catch (e) {}

    /* Hide the (now empty) video wrap */
    bgVideoWrap.style.display = 'none';

    /* Insert a full-cover static image behind all layers */
    var img = document.createElement('div');
    img.id = 'bg-static-fallback';
    img.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:1',                           /* same level as bg-video-wrap */
      'background:url(./assets/kvf-logo-4k.png) center center / cover no-repeat',
      'background-color:#000',
      'pointer-events:none'
    ].join(';');

    /* Insert right after base-bg so it sits at z:1 under all overlays */
    var baseBg = $('base-bg');
    if (baseBg && baseBg.parentNode) {
      baseBg.parentNode.insertBefore(img, baseBg.nextSibling);
    } else {
      document.getElementById('homepage').prepend(img);
    }
  }

  /* Start a timer — if canplay never fires, fall back to static image */
  bgCanplayTimer = setTimeout(function () {
    if (!bgFallbackApplied) applyBgFallback();
  }, BG_CANPLAY_MS);


  /* ══════════════════════════════════════════════════════════════
     SOUND TOGGLE
  ══════════════════════════════════════════════════════════════ */
  function setSoundIcon(muted) {
    if (!iconMuted || !iconUnmuted) return;
    if (muted) {
      iconMuted.style.display   = '';
      iconUnmuted.style.display = 'none';
      soundToggle.setAttribute('aria-label', 'Sound Off — click to enable audio');
      soundToggle.setAttribute('title', 'Sound Off');
      soundToggle.classList.remove('unmuted');
    } else {
      iconMuted.style.display   = 'none';
      iconUnmuted.style.display = '';
      soundToggle.setAttribute('aria-label', 'Sound On — click to mute');
      soundToggle.setAttribute('title', 'Sound On');
      soundToggle.classList.add('unmuted');
    }
  }

  function applyMuteState(muted) {
    [introVideo, bgVideoA, bgVideoB].forEach(function (v) {
      if (!v) return;
      v.muted  = muted;
      v.volume = muted ? 0 : 1;
    });
  }

  function showSoundToggle() {
    if (!soundToggle) return;
    soundToggle.classList.remove('hidden');
    setTimeout(function () { soundToggle.classList.add('visible'); }, 40);
  }

  function hideSoundToggle() {
    if (!soundToggle) return;
    soundToggle.classList.remove('visible');
    soundToggle.classList.add('hidden');
  }

  if (soundToggle) {
    soundToggle.addEventListener('click', function () {
      isMuted = !isMuted;
      applyMuteState(isMuted);
      setSoundIcon(isMuted);
    });
  }

  setSoundIcon(true);
  applyMuteState(true);


  /* ══════════════════════════════════════════════════════════════
     BG VIDEOS — both start loading immediately from t=0 in sync.
     Because both videos contain identical content and both start
     from currentTime=0 together, they stay frame-accurate in sync.
     The idle video plays silently under opacity:0 so the decoder
     is always warm. Swaps blend identical frames → invisible.
  ══════════════════════════════════════════════════════════════ */

  /* Give both videos the loop attribute so they never stop on their own */
  bgVideoA.loop = true;
  bgVideoB.loop = true;

  /* Load and start both from t=0 as close together as possible.
     We use a single canplay listener on A; once A is ready we start
     both simultaneously so they remain frame-accurate in sync.     */
  var bgAReady = false;
  var bgBReady = false;

  function tryStartBothSync() {
    if (!bgAReady || !bgBReady) return;
    /* Both decoders are ready — cancel fallback timer, seek to 0, start */
    clearTimeout(bgCanplayTimer);
    bgVideoA.currentTime = 0;
    bgVideoB.currentTime = 0;
    bgVideoA.play().catch(function () {});
    bgVideoB.play().catch(function () {});
  }

  bgVideoA.addEventListener('canplay', function onAReady() {
    bgVideoA.removeEventListener('canplay', onAReady);
    bgAReady = true;
    tryStartBothSync();
  });
  bgVideoB.addEventListener('canplay', function onBReady() {
    bgVideoB.removeEventListener('canplay', onBReady);
    bgBReady = true;
    tryStartBothSync();
  });

  /* If either bg video errors, attempt the other; if both fail → fallback */
  var bgAErrored = false;
  var bgBErrored = false;

  bgVideoA.addEventListener('error', function () {
    bgAErrored = true;
    if (bgBErrored) applyBgFallback();
  }, { once: true });
  bgVideoB.addEventListener('error', function () {
    bgBErrored = true;
    if (bgAErrored) applyBgFallback();
  }, { once: true });

  /* Also watch for stalling on the active bg video AFTER it starts */
  var bgStallTimer = null;
  function resetBgStallTimer() {
    clearTimeout(bgStallTimer);
    bgStallTimer = setTimeout(function () {
      /* Only apply fallback if we haven't already started playing fine */
      if (!bgFallbackApplied && bgVideoA.paused && bgVideoB.paused) {
        applyBgFallback();
      }
    }, 8000);  /* 8 s of stall → give up and show static bg            */
  }

  bgVideoA.addEventListener('waiting', resetBgStallTimer);
  bgVideoA.addEventListener('playing', function () { clearTimeout(bgStallTimer); });
  bgVideoB.addEventListener('playing', function () { clearTimeout(bgStallTimer); });

  bgVideoA.load();
  bgVideoB.load();


  /* ══════════════════════════════════════════════════════════════
     DUAL-VIDEO LOOP ENGINE
     Uses rAF to watch activeVid.currentTime.
     When it reaches (duration - LOOP_XFADE_SEC):
       1. Swap CSS classes — both videos are at the SAME currentTime
          so the opacity crossfade blends identical frames (invisible)
       2. Swap role vars (activeVid ↔ idleVid)
       3. After CSS transition ends: seek the now-hidden outgoing
          video back to t=0 and let it play silently for ~5.5 s
          so it arrives at the next swap point in perfect sync again
     No seek ever happens while a video is visible → zero glitches.
  ══════════════════════════════════════════════════════════════ */
  function startLoopEngine() {
    if (loopRafId) return;
    if (bgFallbackApplied) return;   /* no videos to loop — static fallback active */

    /* Ensure correct initial CSS state */
    bgVideoA.classList.remove('bg-idle');
    bgVideoA.classList.add('bg-active');
    bgVideoB.classList.remove('bg-active');
    bgVideoB.classList.add('bg-idle');

    activeVid = bgVideoA;
    idleVid   = bgVideoB;

    function tick() {
      loopRafId = requestAnimationFrame(tick);

      if (swapping) return;

      var ct  = activeVid.currentTime;
      var dur = activeVid.duration;

      /* Need real playback data before watching */
      if (!isFinite(dur) || dur < 0.5 || ct < 0.05) return;

      /* Use detected duration with a small safety margin */
      var swapAt = dur - LOOP_XFADE_SEC;
      if (swapAt < 0.1) swapAt = 0.1;   /* safety for very short clips */

      if (ct < swapAt) return;

      /* ── BEGIN SWAP ──────────────────────────────────────── */
      swapping = true;

      /* DO NOT seek idleVid here. Both videos have been playing since
         t=0 (or since their last reset), so activeVid and idleVid are
         at the SAME currentTime right now — the crossfade blends two
         identical frames, making the transition completely invisible.
         Seeking idleVid to 0 here would cause a decoder flush that
         creates a visible flash/stutter at the start of the fade. */

      /* Ensure idle video is actually playing and has correct sound */
      idleVid.muted  = isMuted;
      idleVid.volume = isMuted ? 0 : 1;
      /* Play in case it was blocked — usually already playing */
      idleVid.play().catch(function () {});

      /* Trigger CSS crossfade — both videos show the same frame,
         so the opacity blend is visually imperceptible */
      activeVid.classList.remove('bg-active');
      activeVid.classList.add('bg-idle');
      idleVid.classList.remove('bg-idle');
      idleVid.classList.add('bg-active');

      /* Capture the outgoing video reference BEFORE swapping roles */
      var outgoing = activeVid;

      /* Swap roles immediately — outgoing becomes the next idle */
      activeVid = idleVid;
      idleVid   = outgoing;

      /* After the CSS transition finishes and the outgoing video is
         fully hidden (opacity:0), seek it back to t=0.
         It then plays silently from 0 for ~5.5 s before the next swap,
         arriving at the swap point at the same currentTime as activeVid.
         No seek ever happens while a video is visible — zero glitches. */
      setTimeout(function () {
        outgoing.currentTime = 0;
        outgoing.play().catch(function () {});
        swapping = false;
      }, LOOP_XFADE_MS + 200);
    }

    loopRafId = requestAnimationFrame(tick);
  }

  function stopLoopEngine() {
    if (loopRafId) {
      cancelAnimationFrame(loopRafId);
      loopRafId = null;
    }
  }


  /* ══════════════════════════════════════════════════════════════
     STEP 1 — REVEAL HOMEPAGE LAYERS
  ══════════════════════════════════════════════════════════════ */
  revealHomepage(0);

  /* ══════════════════════════════════════════════════════════════
     STEP 2 — FILM GRAIN (always running)
  ══════════════════════════════════════════════════════════════ */
  initGrain();


  /* ══════════════════════════════════════════════════════════════
     STEP 3 — INTRO VIDEO
     Smooth-playback strategy:
       • Poster image shows immediately (no black screen while loading)
       • Wait for canplaythrough before revealing + playing — guarantees
         enough data is buffered for stutter-free playback
       • canplay fallback: if canplaythrough never fires within 1 s of
         canplay firing, start anyway (fast connections won't wait long)
       • Rebuffering watchdog: if 'waiting' fires mid-playback, pause,
         wait for canplaythrough again, then resume — eliminates jumps
       • Hard 3 s global timeout: if nothing loads at all, skipIntro()
       • All paths lead to homepage — no infinite black screen possible
  ══════════════════════════════════════════════════════════════ */

  var introCPTfired = false;   /* canplaythrough received           */
  var introStarted  = false;   /* play() has been called once       */
  var reBuffering   = false;   /* mid-play rebuffer in progress     */
  var cptFallback   = null;    /* timer: canplay → canplaythrough   */

  /* ── Attempt to play (always muted for autoplay compat) ─────── */
  function tryPlayIntro() {
    if (transitionStarted) return;
    introStarted = true;
    introLoader.classList.add('hidden');
    introVideo.classList.add('playing');
    var p = introVideo.play();
    if (p && typeof p.then === 'function') {
      p.then(function () { videoStarted = true; })
       .catch(function () {
         /* Autoplay blocked — wait for first touch to retry */
         introVideo.classList.remove('playing');
       });
    } else {
      videoStarted = true;
    }
  }

  /* ── canplaythrough: enough buffered to play without stalling ── */
  introVideo.addEventListener('canplaythrough', function onCPT() {
    introVideo.removeEventListener('canplaythrough', onCPT);
    introCPTfired = true;
    clearTimeout(cptFallback);
    clearTimeout(stallTimer);

    if (reBuffering) {
      /* Mid-play rebuffer resolved — resume silently */
      reBuffering = false;
      introVideo.play().catch(function () {});
      return;
    }

    if (!introStarted) {
      introLoader.classList.add('hidden');
      tryPlayIntro();
      setTimeout(showSoundToggle, 800);
    }
  });

  /* ── canplay: first decodable frame ready ───────────────────── */
  introVideo.addEventListener('canplay', function onCP() {
    introVideo.removeEventListener('canplay', onCP);
    clearTimeout(stallTimer);
    introLoader.classList.add('hidden');

    if (!introCPTfired) {
      /* Give canplaythrough up to 1 s to arrive on fast connections;
         if it doesn't fire by then, start playing anyway */
      cptFallback = setTimeout(function () {
        if (!introCPTfired && !introStarted && !transitionStarted) {
          introCPTfired = true;   /* treat as buffered-enough */
          tryPlayIntro();
          setTimeout(showSoundToggle, 800);
        }
      }, 1000);
    }
  });

  /* ── loadeddata: first frame decoded — hide spinner early ───── */
  introVideo.addEventListener('loadeddata', function () {
    introLoader.classList.add('hidden');
  });

  /* ── timeupdate: normal playback progress ───────────────────── */
  introVideo.addEventListener('timeupdate', function () {
    if (transitionStarted) return;
    videoStarted = true;
    clearTimeout(stallTimer);
    if (introVideo.currentTime >= INTRO_FADE_SEC) {
      beginCrossfade();
    }
  });

  /* ── ended: video finished before reaching INTRO_FADE_SEC ───── */
  introVideo.addEventListener('ended', function () {
    if (!transitionStarted) beginCrossfade();
  }, { once: true });

  /* ── error / source error ────────────────────────────────────── */
  introVideo.addEventListener('error', function () {
    skipIntro();
  }, { once: true });

  var sources    = introVideo.querySelectorAll('source');
  var lastSource = sources[sources.length - 1];
  if (lastSource) {
    lastSource.addEventListener('error', function () {
      if (!transitionStarted) skipIntro();
    }, { once: true });
  }

  /* ── waiting: mid-play rebuffer (stutter prevention) ────────── */
  introVideo.addEventListener('waiting', function () {
    if (!transitionStarted && introStarted) {
      reBuffering = true;
      /* Pause cleanly — canplaythrough listener above will resume */
      introVideo.pause();
      /* Safety: if canplaythrough never re-fires, arm stall timer */
      resetStallTimer();
    }
  });

  /* ── playing: rebuffer or initial play resolved ─────────────── */
  introVideo.addEventListener('playing', function () {
    reBuffering = false;
    videoStarted = true;
    clearTimeout(stallTimer);
  });

  /* ── Hard 3-second global timeout ───────────────────────────── */
  function resetStallTimer() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(function () {
      if (!transitionStarted) skipIntro();
    }, STALL_TIMEOUT_MS);
  }
  resetStallTimer();  /* arm immediately on page load */

  /* ── First-touch wake for mobile autoplay blocks ─────────────── */
  document.addEventListener('touchstart', function wakeVideo() {
    document.removeEventListener('touchstart', wakeVideo);
    if (transitionStarted) return;
    if (introVideo.paused && introStarted) {
      introVideo.play().catch(function () {});
    } else if (!introStarted && introCPTfired) {
      tryPlayIntro();
    }
  }, { passive: true });

  /* ── Tab visibility ──────────────────────────────────────────── */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      introVideo.pause();
      if (transitionStarted) {
        bgVideoA.pause();
        bgVideoB.pause();
        stopLoopEngine();
      }
    } else {
      if (!transitionStarted) {
        if (introStarted) introVideo.play().catch(function () {});
      } else {
        if (!bgFallbackApplied) {
          bgVideoA.play().catch(function () {});
          bgVideoB.play().catch(function () {});
          startLoopEngine();
        }
      }
    }
  });

  introVideo.load();


  /* ══════════════════════════════════════════════════════════════
     FIRST-INTERACTION AUTO-UNMUTE
     On the very first click/tap anywhere on the page, unmute all
     videos and flip the toggle to ON. Fires once then removes itself.
     This handles browsers that block autoplay with audio.
  ══════════════════════════════════════════════════════════════ */
  var firstInteractionDone = false;

  function onFirstInteraction(e) {
    /* Ignore clicks that are directly on the sound toggle — the toggle
       handler will manage the state change itself */
    if (firstInteractionDone) return;
    if (soundToggle && soundToggle.contains(e.target)) return;

    firstInteractionDone = true;
    document.removeEventListener('click',     onFirstInteraction, true);
    document.removeEventListener('touchstart', onFirstInteraction, true);

    /* Unmute and switch icon to ON */
    isMuted = false;
    applyMuteState(false);
    setSoundIcon(false);
  }

  document.addEventListener('click',     onFirstInteraction, true);
  document.addEventListener('touchstart', onFirstInteraction, { capture: true, passive: true });


  /* ══════════════════════════════════════════════════════════════
     INTRO → BG CROSSFADE
     Toggle is NOT hidden during crossfade — it stays visible and
     persists on the homepage. After the transition completes the
     toggle is re-shown (in case it was in mid-fade) so it's crisp.
  ══════════════════════════════════════════════════════════════ */
  function beginCrossfade() {
    if (transitionStarted) return;
    transitionStarted = true;
    clearTimeout(stallTimer);

    applyMuteState(isMuted);

    introScreen.classList.add('fade-out');
    bgVideoWrap.classList.add('visible');

    /* Keep toggle visible through crossfade — re-show it cleanly */
    showSoundToggle();

    startLoopEngine();

    setTimeout(function () {
      introScreen.style.display = 'none';
      introVideo.pause();
      introVideo.src = '';
    }, INTRO_XFADE_MS + 200);

    document.body.classList.remove('intro-active');
  }

  function skipIntro() {
    if (transitionStarted) return;
    transitionStarted = true;
    clearTimeout(stallTimer);
    try { introVideo.pause(); } catch (e) {}

    applyMuteState(isMuted);

    introScreen.classList.add('fade-out');
    bgVideoWrap.classList.add('visible');

    /* Keep toggle visible */
    showSoundToggle();
    startLoopEngine();

    setTimeout(function () {
      introScreen.style.display = 'none';
      introVideo.src = '';
    }, INTRO_XFADE_MS + 200);

    document.body.classList.remove('intro-active');
  }


  /* ══════════════════════════════════════════════════════════════
     HOMEPAGE REVEAL
  ══════════════════════════════════════════════════════════════ */
  function revealHomepage(d) {
    d = (typeof d === 'number') ? d : 0;

    after(d + 60,   function () {
      logoGlow.classList.add('visible');
      overlay.classList.add('visible');
    });
    after(d + 120,  function () { vignette.classList.add('visible'); });
    after(d + 280,  function () {
      smokes.forEach(function (s) { s.classList.add('visible'); });
    });
    after(d + 460,  function () {
      pCanvas.classList.add('visible');
      initEmbers();
    });
    after(d + 700,  function () { grainCanvas.classList.add('visible'); });
    after(d + 800,  function () { siteHeader.classList.add('visible'); });
    words.forEach(function (w, i) {
      after(d + 1200 + i * 210, function () { w.classList.add('in'); });
    });
    var textEnd = d + 1200 + words.length * 210;
    after(textEnd + 520, function () { if (heroTagline) heroTagline.classList.add('in'); });
    after(textEnd + 860, function () { scrollCue.classList.add('in'); });
  }

  function after(ms, fn) { setTimeout(fn, Math.max(0, ms)); }


  /* ══════════════════════════════════════════════════════════════
     FILM GRAIN — warm-tinted noise canvas, ~20 fps
  ══════════════════════════════════════════════════════════════ */
  function initGrain() {
    if (!grainCanvas || grainCanvas._kvfGrain) return;
    grainCanvas._kvfGrain = true;

    var ctx = grainCanvas.getContext('2d');
    var W, H, imgData;

    function resize() {
      W = grainCanvas.width  = window.innerWidth;
      H = grainCanvas.height = window.innerHeight;
      imgData = ctx.createImageData(W, H);
    }
    resize();
    window.addEventListener('resize', resize, { passive: true });

    var frame = 0;
    (function tickGrain() {
      frame++;
      if (frame % 3 === 0) {
        var data = imgData.data;
        for (var i = 0; i < data.length; i += 4) {
          var v    = (Math.random() * 255) | 0;
          data[i]  = v + 8;
          data[i+1]= v + 3;
          data[i+2]= v - 4;
          data[i+3]= 255;
        }
        ctx.putImageData(imgData, 0, 0);
      }
      requestAnimationFrame(tickGrain);
    })();
  }


  /* ══════════════════════════════════════════════════════════════
     GOLD EMBER PARTICLE SYSTEM — 42 upward-drifting embers
  ══════════════════════════════════════════════════════════════ */
  function initEmbers() {
    if (pCanvas._kvfEmbers) return;
    pCanvas._kvfEmbers = true;

    var ctx = pCanvas.getContext('2d');
    var N   = 42;
    var W, H;

    function resize() {
      W = pCanvas.width  = window.innerWidth;
      H = pCanvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize, { passive: true });

    function mkP(fromBottom) {
      var b = Math.random();
      return {
        x:   Math.random() * W,
        y:   fromBottom ? H + 12 : Math.random() * H,
        sz:  Math.random() * 2.2 + 0.3,
        vx:  (Math.random() - 0.5) * 0.20,
        vy:  -(Math.random() * 0.34 + 0.06),
        op:  Math.random() * 0.30 + 0.05,
        mop: Math.random() * 0.40 + 0.10,
        dir: Math.random() > 0.5 ? 1 : -1,
        spd: Math.random() * 0.003 + 0.001,
        r:   198 + Math.floor(b * 40),
        g:   150 + Math.floor(b * 58),
        b_:   38 + Math.floor(b * 46),
        life: 0,
        ml:  Math.random() * 800 + 200
      };
    }

    var P = [];
    for (var i = 0; i < N; i++) { P.push(mkP(false)); }

    (function tick() {
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < P.length; i++) {
        var p = P[i];
        p.x += p.vx; p.y += p.vy; p.life++;
        p.op += p.spd * p.dir;
        if (p.op >= p.mop) { p.op = p.mop; p.dir = -1; }
        if (p.op <= 0.02)  { p.op = 0.02;  p.dir =  1; }
        if (p.y < -16 || p.x < -16 || p.x > W + 16 || p.life > p.ml) {
          P[i] = mkP(true); continue;
        }
        var rad = p.sz * 3.4;
        var g   = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        g.addColorStop(0, 'rgba('+p.r+','+p.g+','+p.b_+','+p.op+')');
        g.addColorStop(1, 'rgba('+p.r+','+p.g+','+p.b_+',0)');
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.sz * 0.46, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba('+
          Math.min(p.r+30,255)+','+
          Math.min(p.g+22,255)+','+
          Math.min(p.b_+18,255)+','+
          Math.min(p.op*2.2,1)+')';
        ctx.fill();
      }
      requestAnimationFrame(tick);
    })();
  }


  /* ── Navigation ─────────────────────────────────────────────── */
  window.addEventListener('scroll', function () {
    siteHeader.classList.toggle('scrolled', window.scrollY > 50);
  }, { passive: true });

  navToggle.addEventListener('click', function () {
    var open = mainNav.classList.toggle('open');
    navToggle.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', String(open));
  });

  mainNav.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      mainNav.classList.remove('open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });

  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var t = document.querySelector(a.getAttribute('href'));
      if (t) { e.preventDefault(); t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  });

  if (scrollCue) {
    scrollCue.addEventListener('click', function () {
      var s = $('about');
      if (s) s.scrollIntoView({ behavior: 'smooth' });
    });
  }

})();
