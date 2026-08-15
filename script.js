/* ═══════════════════════════════════════════════════════════════
   KINGDOM VISION FILMS — script.js
   Cinematic Engine v17 — Guaranteed Video Crossfade Edition

   ARCHITECTURE:
   ─────────────────────────────────────────────────────────────
   Phase 1 — INTRO
     • Intro video plays once (preload=auto, poster shown instantly)
     • canplaythrough gate ensures smooth playback before starting
     • 3 s hard timeout skips intro if nothing loads
     • At t=9.3 s → beginCrossfade()

   Phase 2 — CROSSFADE (1.8 s)
     • BG video A was preloading silently during intro (opacity:0)
     • BG video A is seeked to t=0 and CONFIRMED playing before
       the wrapper opacity transition starts — no black gap
     • intro-screen fades 1→0 while bg-video-wrap fades 0→1
       simultaneously over 1.8 s — no black in between

   Phase 3 — HOMEPAGE LOOP (dual-video seamless)
     • Video A plays. Video B mirrors it silently (same src, same t=0 start)
     • At (duration − 1.5 s): CSS crossfade A→B over 1.5 s
       Both videos show identical frames → transition invisible
     • After fade: outgoing video reset to t=0, plays silently
     • Alternates continuously — never pauses, never cuts

   FALLBACK (never black screen):
     • BG canplay timeout = 20 s (generous for CDN/mobile)
     • Fallback only fires if BOTH videos error AND canplay never fires
     • Fallback shows kvf-logo-4k.png static background
     • Even in fallback the wrapper is shown, not display:none

   SOUND:
     • isMuted shared across all 3 videos
     • First interaction auto-unmutes (browser autoplay policy)
     • Sound toggle persists through entire lifecycle
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Debug logger ───────────────────────────────────────────── */
  function kvfLog(msg, data) {
    var out = '[KVF] ' + msg;
    if (data !== undefined) { console.log(out, data); } else { console.log(out); }
  }
  kvfLog('script.js loaded — KVF Cinematic Engine v17');

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

  /* ── Timing constants ───────────────────────────────────────── */
  var INTRO_FADE_SEC   = 9.3;     /* start crossfade at this intro time   */
  var INTRO_XFADE_MS   = 1800;    /* 1.8 s crossfade as required          */
  var STALL_TIMEOUT_MS = 3000;    /* 3 s hard timeout → skip intro        */
  var BG_CANPLAY_MS    = 20000;   /* 20 s before bg fallback fires        */
  /* NOTE: loop-swap timing is derived at runtime from the actual media
     duration (activeVid.duration) — never a hard-coded constant — so the
     R2 background video's real length drives the crossfade automatically. */
  var LOOP_XFADE_SEC   = 1.5;     /* seconds before end → start loop swap */
  var LOOP_XFADE_MS    = 1500;    /* must match CSS transition duration   */

  /* ── State ──────────────────────────────────────────────────── */
  var transitionStarted = false;
  var stallTimer        = null;
  var videoStarted      = false;
  var isMuted           = true;

  /* Dual-video loop state */
  var activeVid = bgVideoA;
  var idleVid   = bgVideoB;
  var swapping  = false;
  var loopRafId = null;

  /* BG readiness state */
  var bgAReady          = false;
  var bgBReady          = false;
  var bgFallbackApplied = false;
  var bgCanplayTimer    = null;
  var bgBothStarted     = false;  /* true once both bg videos are playing */
  var audioDucked       = false;  /* true while another experience (e.g. Mahogany
                                     Row) owns the audio — homepage stays silenced */


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
    if (introVideo) { introVideo.muted = muted; introVideo.volume = muted ? 0 : 1; }
    /* Only the ACTIVE (visible) background video carries audio. The idle
       one is always kept muted so the two in-sync loop videos can never
       produce doubled/flanged audio during the dual-video crossfade. */
    if (activeVid) { activeVid.muted = muted; activeVid.volume = muted ? 0 : 1; }
    if (idleVid)   { idleVid.muted   = true;  idleVid.volume   = 0; }
  }

  /* ══════════════════════════════════════════════════════════════
     AUDIO OWNERSHIP HOOK
     Lets a separate experience (the Mahogany Row motion banner) take
     over as the ONLY audio source. Ducking pauses + mutes the homepage
     videos and halts the loop engine (so a loop swap can't re-unmute
     them); restoring resumes playback and the prior mute state. Exposed
     on window so the self-contained IN DEVELOPMENT module can call it
     without reaching into this engine's internals.
  ══════════════════════════════════════════════════════════════ */
  window.kvfDuckHomepageAudio = function (duck) {
    audioDucked = !!duck;
    if (audioDucked) {
      try { introVideo.pause(); } catch (e) {}
      try { bgVideoA.pause(); }  catch (e) {}
      try { bgVideoB.pause(); }  catch (e) {}
      [introVideo, bgVideoA, bgVideoB].forEach(function (v) {
        if (v) { v.muted = true; v.volume = 0; }
      });
      stopLoopEngine();
    } else {
      if (transitionStarted && !bgFallbackApplied) {
        bgVideoA.play().catch(function () {});
        bgVideoB.play().catch(function () {});
        startLoopEngine();
      }
      applyMuteState(isMuted);
    }
  };

  function showSoundToggle() {
    if (!soundToggle) return;
    soundToggle.classList.remove('hidden');
    setTimeout(function () { soundToggle.classList.add('visible'); }, 40);
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
     FIRST-INTERACTION AUTO-UNMUTE
     Browser autoplay policy: first user gesture unmutes everything.
  ══════════════════════════════════════════════════════════════ */
  var firstInteractionDone = false;

  function onFirstInteraction(e) {
    if (firstInteractionDone) return;
    if (soundToggle && soundToggle.contains(e.target)) return;
    firstInteractionDone = true;
    document.removeEventListener('click',     onFirstInteraction, true);
    document.removeEventListener('touchstart', onFirstInteraction, true);
    isMuted = false;
    applyMuteState(false);
    setSoundIcon(false);
  }

  document.addEventListener('click',     onFirstInteraction, true);
  document.addEventListener('touchstart', onFirstInteraction, { capture: true, passive: true });


  /* ══════════════════════════════════════════════════════════════
     BG VIDEO FALLBACK
     Only fires if canplay never arrives within 20 s OR both error.
     Shows static KVF image — never leaves a pure black screen.
     NOTE: we do NOT use display:none on bgVideoWrap — we replace
     the background with an image so overlays still render correctly.
  ══════════════════════════════════════════════════════════════ */
  function applyBgFallback() {
    if (bgFallbackApplied) return;
    bgFallbackApplied = true;
    kvfLog('BG fallback applied — showing static KVF image');

    clearTimeout(bgCanplayTimer);

    /* Stop videos */
    try { bgVideoA.pause(); bgVideoA.removeAttribute('src'); bgVideoA.load(); } catch (e) {}
    try { bgVideoB.pause(); bgVideoB.removeAttribute('src'); bgVideoB.load(); } catch (e) {}

    /* Replace video wrap background with static image — keep it visible */
    bgVideoWrap.style.background =
      'url(./assets/kvf-logo-4k.png) center center / cover no-repeat #000';

    /* Make sure the wrap is visible so the static image shows */
    bgVideoWrap.classList.add('visible');
  }

  /* ── BG canplay timeout — 20 s is generous enough for any network ── */
  bgCanplayTimer = setTimeout(function () {
    if (!bgFallbackApplied && !bgBothStarted) {
      kvfLog('BG canplay timeout — applying fallback');
      applyBgFallback();
    }
  }, BG_CANPLAY_MS);


  /* ══════════════════════════════════════════════════════════════
     BG VIDEO PRELOAD
     Both videos load silently during the intro. They do NOT play
     yet — we only confirm canplay so decoders are warm.
     Actual play() is called inside beginCrossfade() once we know
     the transition is about to happen. This ensures both videos
     are at t=0 and confirmed playing when the wrapper fades in.
  ══════════════════════════════════════════════════════════════ */
  bgVideoA.loop = true;
  bgVideoB.loop = true;

  /* Keep both muted during preload (required for autoplay) */
  bgVideoA.muted = true; bgVideoA.volume = 0;
  bgVideoB.muted = true; bgVideoB.volume = 0;

  bgVideoA.addEventListener('canplay', function onAReady() {
    bgVideoA.removeEventListener('canplay', onAReady);
    bgAReady = true;
    kvfLog('BG video A — canplay fired');
    /* Do NOT play yet — wait for crossfade trigger */
  });

  bgVideoB.addEventListener('canplay', function onBReady() {
    bgVideoB.removeEventListener('canplay', onBReady);
    bgBReady = true;
    kvfLog('BG video B — canplay fired');
  });

  var bgAErrored = false;
  var bgBErrored = false;

  bgVideoA.addEventListener('error', function () {
    bgAErrored = true;
    kvfLog('BG video A — error', bgVideoA.error ? bgVideoA.error.message : 'unknown');
    if (bgBErrored) applyBgFallback();
  }, { once: true });

  bgVideoB.addEventListener('error', function () {
    bgBErrored = true;
    kvfLog('BG video B — error', bgVideoB.error ? bgVideoB.error.message : 'unknown');
    if (bgAErrored) applyBgFallback();
  }, { once: true });

  /* Trigger preload — browsers load metadata + first segment */
  bgVideoA.load();
  bgVideoB.load();


  /* ══════════════════════════════════════════════════════════════
     DUAL-VIDEO SEAMLESS LOOP ENGINE
     Called AFTER both bg videos are confirmed playing.
     Watches activeVid.currentTime via rAF.
     At (duration − 1.5 s): crossfades A→B (or B→A).
     Both videos stay in sync → frames match → invisible blend.
  ══════════════════════════════════════════════════════════════ */
  function startLoopEngine() {
    if (loopRafId) return;
    if (bgFallbackApplied) return;

    /* Set correct initial CSS state */
    bgVideoA.classList.remove('bg-idle');
    bgVideoA.classList.add('bg-active');
    bgVideoB.classList.remove('bg-active');
    bgVideoB.classList.add('bg-idle');

    activeVid = bgVideoA;
    idleVid   = bgVideoB;

    kvfLog('Loop engine started');

    function tick() {
      loopRafId = requestAnimationFrame(tick);
      if (swapping) return;

      var ct  = activeVid.currentTime;
      var dur = activeVid.duration;

      if (!isFinite(dur) || dur < 0.5 || ct < 0.1) return;

      var swapAt = dur - LOOP_XFADE_SEC;
      if (swapAt < 0.1) swapAt = 0.1;
      if (ct < swapAt) return;

      /* ── BEGIN SWAP ─────────────────────────────────────── */
      swapping = true;
      kvfLog('Loop swap — ' + (activeVid === bgVideoA ? 'A→B' : 'B→A'));

      var incoming = idleVid;
      var outgoing = activeVid;

      /* Hand audio to the incoming (soon-visible) video and silence the
         outgoing one, so exactly one background track is ever audible.
         Both videos are in sync, so the hand-off is seamless AND doubled
         audio can never occur during the crossfade. */
      incoming.muted  = isMuted;
      incoming.volume = isMuted ? 0 : 1;
      incoming.play().catch(function () {});
      outgoing.muted  = true;
      outgoing.volume = 0;

      /* CSS crossfade — both at same currentTime → invisible blend */
      outgoing.classList.remove('bg-active');
      outgoing.classList.add('bg-idle');
      incoming.classList.remove('bg-idle');
      incoming.classList.add('bg-active');

      activeVid = incoming;
      idleVid   = outgoing;

      /* After CSS transition completes: reset outgoing to t=0 so it
         stays in sync for the next swap. Never seek while visible. */
      setTimeout(function () {
        outgoing.currentTime = 0;
        outgoing.play().catch(function () {});
        swapping = false;
      }, LOOP_XFADE_MS + 200);
    }

    loopRafId = requestAnimationFrame(tick);
  }

  function stopLoopEngine() {
    if (loopRafId) { cancelAnimationFrame(loopRafId); loopRafId = null; }
  }


  /* ══════════════════════════════════════════════════════════════
     STEP 1 — REVEAL HOMEPAGE LAYERS (runs immediately)
  ══════════════════════════════════════════════════════════════ */
  revealHomepage(0);

  /* ══════════════════════════════════════════════════════════════
     STEP 2 — FILM GRAIN (always running)
  ══════════════════════════════════════════════════════════════ */
  initGrain();


  /* ══════════════════════════════════════════════════════════════
     STEP 3 — INTRO VIDEO
     canplaythrough gate → smooth playback guaranteed.
     canplay fallback → 1 s grace period for fast connections.
     3 s global hard timeout → always reaches homepage.
  ══════════════════════════════════════════════════════════════ */
  var introCPTfired = false;
  var introStarted  = false;
  var reBuffering   = false;
  var cptFallback   = null;

  function tryPlayIntro() {
    if (transitionStarted) return;
    introStarted = true;
    introLoader.classList.add('hidden');
    introVideo.classList.add('playing');
    var p = introVideo.play();
    if (p && typeof p.then === 'function') {
      p.then(function () {
        videoStarted = true;
        kvfLog('Intro video playing');
      }).catch(function () {
        introVideo.classList.remove('playing');
      });
    } else {
      videoStarted = true;
    }
  }

  introVideo.addEventListener('canplaythrough', function onCPT() {
    introVideo.removeEventListener('canplaythrough', onCPT);
    introCPTfired = true;
    kvfLog('Intro video — canplaythrough fired');
    clearTimeout(cptFallback);
    clearTimeout(stallTimer);

    if (reBuffering) {
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

  introVideo.addEventListener('canplay', function onCP() {
    introVideo.removeEventListener('canplay', onCP);
    kvfLog('Intro video — canplay fired');
    clearTimeout(stallTimer);
    introLoader.classList.add('hidden');

    if (!introCPTfired) {
      cptFallback = setTimeout(function () {
        if (!introCPTfired && !introStarted && !transitionStarted) {
          introCPTfired = true;
          tryPlayIntro();
          setTimeout(showSoundToggle, 800);
        }
      }, 1000);
    }
  });

  introVideo.addEventListener('loadeddata', function () {
    introLoader.classList.add('hidden');
  });

  introVideo.addEventListener('timeupdate', function () {
    if (transitionStarted) return;
    videoStarted = true;
    clearTimeout(stallTimer);
    if (introVideo.currentTime >= INTRO_FADE_SEC) {
      beginCrossfade();
    }
  });

  introVideo.addEventListener('ended', function () {
    if (!transitionStarted) beginCrossfade();
  }, { once: true });

  introVideo.addEventListener('error', function () {
    kvfLog('Intro video error — skipping', introVideo.error ? introVideo.error.message : '');
    skipIntro();
  }, { once: true });

  var sources    = introVideo.querySelectorAll('source');
  var lastSource = sources[sources.length - 1];
  if (lastSource) {
    lastSource.addEventListener('error', function () {
      if (!transitionStarted) skipIntro();
    }, { once: true });
  }

  introVideo.addEventListener('waiting', function () {
    if (!transitionStarted && introStarted) {
      reBuffering = true;
      introVideo.pause();
      resetStallTimer();
    }
  });

  introVideo.addEventListener('playing', function () {
    reBuffering = false;
    videoStarted = true;
    clearTimeout(stallTimer);
  });

  /* Hard 3 s global timeout */
  function resetStallTimer() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(function () {
      if (!transitionStarted) {
        kvfLog('Intro stall timeout — skipping to homepage');
        skipIntro();
      }
    }, STALL_TIMEOUT_MS);
  }
  resetStallTimer();

  /* Mobile autoplay wake */
  document.addEventListener('touchstart', function wakeVideo() {
    document.removeEventListener('touchstart', wakeVideo);
    if (transitionStarted) return;
    if (introVideo.paused && introStarted) {
      introVideo.play().catch(function () {});
    } else if (!introStarted && introCPTfired) {
      tryPlayIntro();
    }
  }, { passive: true });

  /* Tab visibility */
  document.addEventListener('visibilitychange', function () {
    if (audioDucked) return;   /* Mahogany Row owns audio/playback — leave homepage paused */
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
     INTRO → BG CROSSFADE
     Critical sequence:
     1. Seek both bg videos to t=0
     2. Play both — wait for confirmed play on A
     3. Apply correct mute state
     4. THEN start the opacity transition (wrapper 0→1, intro 1→0)
     5. Start loop engine
     This guarantees video content is visible the moment the
     wrapper becomes opaque — zero black gap.
  ══════════════════════════════════════════════════════════════ */
  function executeCrossfade() {
    kvfLog('Crossfade executing — bg video starting');

    /* Apply current mute state */
    applyMuteState(isMuted);

    /* Seek both to t=0 for a clean start */
    try { bgVideoA.currentTime = 0; } catch (e) {}
    try { bgVideoB.currentTime = 0; } catch (e) {}

    /* Start A playing — confirmed via promise or fallback */
    var playPromise = bgVideoA.play();

    /* Runs exactly once. Guards against the play() promise and the safety
       timer both firing. */
    var crossfadeDone = false;

    function doFade() {
      if (crossfadeDone) return;
      crossfadeDone = true;
      clearTimeout(revealSafety);
      kvfLog('BG video A confirmed playing — starting opacity crossfade');
      bgBothStarted = true;
      clearTimeout(bgCanplayTimer);

      /* Start B playing silently in sync */
      bgVideoB.play().catch(function () {});

      /* Fire the opacity transitions simultaneously */
      introScreen.classList.add('fade-out');       /* intro: 1 → 0 */
      bgVideoWrap.classList.add('visible');         /* bg wrap: 0 → 1 */

      showSoundToggle();
      startLoopEngine();

      /* Clean up intro after transition */
      setTimeout(function () {
        introScreen.style.display = 'none';
        try { introVideo.pause(); introVideo.src = ''; } catch (e) {}
      }, INTRO_XFADE_MS + 300);

      document.body.classList.remove('intro-active');
    }

    /* Safety net — the R2 background video is remote, so a network error
       can leave bgVideoA.play() pending forever (no resolve, no reject,
       no error event). Never let the intro loader hang: if play() has not
       confirmed within a generous window (the bg has already been
       preloading throughout the intro), reveal the homepage over the
       existing static fallback image instead of a black screen. */
    var revealSafety = setTimeout(function () {
      if (crossfadeDone) return;
      crossfadeDone = true;
      kvfLog('BG video did not start in time — revealing homepage over static fallback');
      applyBgFallback();                             /* static KVF image  */
      introScreen.classList.add('fade-out');         /* intro: 1 → 0      */
      bgVideoWrap.classList.add('visible');          /* bg wrap: 0 → 1    */
      showSoundToggle();
      setTimeout(function () {
        introScreen.style.display = 'none';
        try { introVideo.pause(); introVideo.src = ''; } catch (e) {}
      }, INTRO_XFADE_MS + 300);
      document.body.classList.remove('intro-active');
    }, 6000);

    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.then(doFade).catch(function () {
        /* play() rejected — still do the fade, video may catch up */
        kvfLog('BG video A play() rejected — fading anyway');
        doFade();
      });
    } else {
      doFade();
    }
  }

  function beginCrossfade() {
    if (transitionStarted) return;
    transitionStarted = true;
    clearTimeout(stallTimer);
    kvfLog('beginCrossfade triggered at t=' + (introVideo.currentTime || 0).toFixed(2) + 's');

    if (bgFallbackApplied) {
      /* BG already in fallback state — just fade intro out */
      introScreen.classList.add('fade-out');
      bgVideoWrap.classList.add('visible');
      showSoundToggle();
      setTimeout(function () {
        introScreen.style.display = 'none';
        try { introVideo.pause(); introVideo.src = ''; } catch (e) {}
      }, INTRO_XFADE_MS + 300);
      document.body.classList.remove('intro-active');
      return;
    }

    if (bgAReady) {
      /* Decoder already warm — execute immediately */
      executeCrossfade();
    } else {
      /* Video still loading — wait up to 2 s for canplay, then go anyway */
      kvfLog('BG not ready yet — waiting for canplay (max 2s)');
      var waitTimer = setTimeout(function () {
        kvfLog('BG canplay wait expired — executing crossfade anyway');
        executeCrossfade();
      }, 2000);

      bgVideoA.addEventListener('canplay', function onBGReady() {
        bgVideoA.removeEventListener('canplay', onBGReady);
        clearTimeout(waitTimer);
        bgAReady = true;
        executeCrossfade();
      });
    }
  }

  function skipIntro() {
    if (transitionStarted) return;
    transitionStarted = true;
    clearTimeout(stallTimer);
    kvfLog('skipIntro — jumping to homepage');
    try { introVideo.pause(); } catch (e) {}

    if (bgFallbackApplied) {
      introScreen.classList.add('fade-out');
      bgVideoWrap.classList.add('visible');
      showSoundToggle();
      setTimeout(function () {
        introScreen.style.display = 'none';
        try { introVideo.src = ''; } catch (e) {}
      }, INTRO_XFADE_MS + 300);
      document.body.classList.remove('intro-active');
      return;
    }

    executeCrossfade();
  }


  /* ══════════════════════════════════════════════════════════════
     HOMEPAGE REVEAL (layers fade in on page load)
  ══════════════════════════════════════════════════════════════ */
  function revealHomepage(d) {
    d = (typeof d === 'number') ? d : 0;

    after(d + 60,  function () {
      logoGlow.classList.add('visible');
      overlay.classList.add('visible');
    });
    after(d + 120, function () { vignette.classList.add('visible'); });
    after(d + 280, function () {
      smokes.forEach(function (s) { s.classList.add('visible'); });
    });
    after(d + 460, function () {
      pCanvas.classList.add('visible');
      initEmbers();
    });
    after(d + 700, function () { grainCanvas.classList.add('visible'); });
    after(d + 800, function () { siteHeader.classList.add('visible'); });
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
      var href = a.getAttribute('href');
      /* Any in-page navigation closes an open IN DEVELOPMENT project first,
         via the single shared cleanup path — stopping every project's motion
         banner + embedded/theme audio before the visitor moves. This covers
         ABOUT / FILMS / CONTACT / homepage AND clicking IN DEVELOPMENT itself
         while a project is expanded (which returns the visitor to the slider).
         With nothing open it is a harmless no-op. */
      if (window.kvfCloseActiveProjects) {
        try { window.kvfCloseActiveProjects(); } catch (err) {}
      }
      var t = document.querySelector(href);
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


/* ═══════════════════════════════════════════════════════════════
   IN DEVELOPMENT — project experience controller (reusable)
   One controller per ACTIVE project slide (any .dev-slide whose
   .slate contains a .slate-video motion banner). Mahogany Row and
   Love Fever share this exact logic — no per-project special cases.
   Both projects embed their theme audio in the MP4 itself: the
   EXPLORE gesture drives a single unmuted video.play() attempt, with
   a muted fallback + subtle SOUND control if the browser blocks it.
   The homepage engine (window.kvfDuckHomepageAudio) and the slider
   (window.kvfSliderLock) provide site-wide audio isolation + freezing.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var section = document.getElementById('projects');
  if (!section) return;

  var mql = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reducedMotion() { return !!(mql && mql.matches); }

  var projects = [];

  function initProject(slate) {
    var video   = slate.querySelector('.slate-video');
    var explore = slate.querySelector('.slate-explore');
    if (!video || !explore) return null;              /* not an active project */
    var backBtn = slate.querySelector('.mr-back');
    var soundBtn= slate.querySelector('.mr-sound');
    var detail  = slate.querySelector('.slate-detail-wrap');

    var P = { opened: false, themeMuted: true, loadStarted: false, unmuteArmed: false };

    function warm() {
      if (P.loadStarted) return;
      try { if (video.preload === 'none') video.preload = 'metadata'; } catch (e) {}
    }
    function beginStreaming() {
      if (P.loadStarted) return;
      P.loadStarted = true;
      try { video.preload = 'auto'; } catch (e) {}
    }
    function reveal() { if (P.opened && !reducedMotion()) video.classList.add('is-playing'); }

    function updateSoundUI() {
      if (!soundBtn) return;
      soundBtn.classList.toggle('is-on', !P.themeMuted);
      soundBtn.classList.toggle('cue', P.themeMuted && P.opened);
      soundBtn.setAttribute('aria-pressed', String(!P.themeMuted));
      soundBtn.setAttribute('aria-label', P.themeMuted ? 'Enable theme music' : 'Mute theme music');
    }

    function onNextGesture(e) {
      if (soundBtn && soundBtn.contains(e.target)) return;
      if (backBtn && backBtn.contains(e.target)) return;
      disarm();
      if (P.opened) {
        P.themeMuted = false; video.muted = false; video.volume = 1;
        if (video.paused) video.play().catch(function () {});
        reveal(); updateSoundUI();
      }
    }
    function arm() {
      if (P.unmuteArmed) return; P.unmuteArmed = true;
      document.addEventListener('pointerdown', onNextGesture, true);
      document.addEventListener('keydown',     onNextGesture, true);
    }
    function disarm() {
      if (!P.unmuteArmed) return; P.unmuteArmed = false;
      document.removeEventListener('pointerdown', onNextGesture, true);
      document.removeEventListener('keydown',     onNextGesture, true);
    }

    function open() {
      if (P.opened) return;
      /* only one project experience owns the screen/audio at a time */
      projects.forEach(function (o) { if (o !== P && o.opened) o.close(); });
      P.opened = true;
      slate.classList.add('expanded');
      explore.setAttribute('aria-expanded', 'true');

      /* Site-wide audio isolation + freeze the slider on this slide */
      if (window.kvfDuckHomepageAudio) { try { window.kvfDuckHomepageAudio(true); } catch (e) {} }
      if (window.kvfSliderLock)        { try { window.kvfSliderLock(true); } catch (e) {} }

      if (detail) {
        setTimeout(function () {
          try { detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
        }, 320);
      }
      if (backBtn) { try { backBtn.focus({ preventScroll: true }); } catch (e) { try { backBtn.focus(); } catch (e2) {} } }

      /* Reduced motion → stay on the still key art, no motion, no audio */
      if (reducedMotion()) { P.themeMuted = true; updateSoundUI(); return; }

      beginStreaming();

      /* Attempt AUDIBLE autoplay directly from this user gesture */
      video.muted = false; video.volume = 1;
      var pr = video.play();
      if (pr && typeof pr.then === 'function') {
        pr.then(function () {
          P.themeMuted = false; updateSoundUI(); reveal();
        }).catch(function () {
          /* Audible autoplay blocked → play muted, invite sound, unmute on next gesture */
          P.themeMuted = true; video.muted = true; video.volume = 0; updateSoundUI();
          video.play().then(reveal).catch(function () { /* key art remains */ });
          arm();
        });
      } else {
        P.themeMuted = !!video.muted; updateSoundUI(); reveal();
      }
    }

    function close() {
      if (!P.opened) return;
      P.opened = false;
      slate.classList.remove('expanded');
      explore.setAttribute('aria-expanded', 'false');
      disarm();

      video.classList.remove('is-playing');
      try { video.pause(); } catch (e) {}
      try { video.muted = true; video.volume = 0; } catch (e) {}
      try { video.currentTime = 0; } catch (e) {}   /* reopen = fresh experience */
      P.themeMuted = true; updateSoundUI();

      if (window.kvfDuckHomepageAudio) { try { window.kvfDuckHomepageAudio(false); } catch (e) {} }
      if (window.kvfSliderLock)        { try { window.kvfSliderLock(false); } catch (e) {} }
      try { explore.focus({ preventScroll: true }); } catch (e) {}
    }

    function toggleSound() {
      P.themeMuted = !P.themeMuted;
      video.muted = P.themeMuted; video.volume = P.themeMuted ? 0 : 1;
      if (!P.themeMuted) { disarm(); if (video.paused) video.play().catch(function () {}); reveal(); }
      updateSoundUI();
    }

    P.close = close;
    P.warm  = warm;

    explore.addEventListener('click', open);
    explore.addEventListener('pointerenter', warm);
    explore.addEventListener('focus', warm);
    if (backBtn)  backBtn.addEventListener('click', close);
    if (soundBtn) soundBtn.addEventListener('click', toggleSound);
    video.addEventListener('loadeddata', reveal);
    video.addEventListener('playing',    reveal);
    video.addEventListener('error', function () { video.classList.remove('is-playing'); });

    return P;
  }

  /* Wire every active-project slide (a slide whose .slate has a motion banner) */
  [].forEach.call(section.querySelectorAll('.dev-slide .slate'), function (slate) {
    var p = initProject(slate);
    if (p) projects.push(p);
  });

  /* ── Single reusable media-stop path ──────────────────────────────
     Closes every open project experience. close() pauses the motion
     banner, stops its embedded audio, resets playback, releases the
     homepage audio isolation, unlocks the slider, and disarms any pending
     unmute — so this covers Love Fever, Mahogany Row, and every future
     IN DEVELOPMENT project with no per-project logic. Exposed on window so
     the navigation controller (and any exit path) can guarantee no project
     soundtrack survives leaving the section. */
  function closeAllProjects() {
    projects.forEach(function (p) { if (p.opened) p.close(); });
  }
  window.kvfCloseActiveProjects = closeAllProjects;

  /* Esc closes whichever project is open */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      closeAllProjects();
    }
  });

  /* Section-level exit safety net: if the whole IN DEVELOPMENT section
     leaves the viewport while project media is active — manual scroll-away,
     rapid or mobile navigation, an interrupted transition — stop it too, so
     cleanup never depends solely on how the visitor left. */
  if ('IntersectionObserver' in window) {
    var exitIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) closeAllProjects();
      });
    }, { threshold: 0 });
    exitIo.observe(section);
  }

  /* Soft cinematic entrance + warm the active banners as the section approaches */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          section.classList.add('in-view');
          projects.forEach(function (p) { p.warm(); });
          io.disconnect();
        }
      });
    }, { threshold: 0.12 });
    io.observe(section);
  } else {
    section.classList.add('in-view');
    projects.forEach(function (p) { p.warm(); });
  }
})();


/* ═══════════════════════════════════════════════════════════════
   IN DEVELOPMENT — single-card cinematic project slider
   One project at a time, cross-dissolve. Mahogany Row is slide 01
   (flagship). Auto-advances ~8s, but pauses on hover/focus/touch,
   while a project is open (kvfSliderLock), when off-screen, when the
   tab is hidden, and under prefers-reduced-motion.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var section = document.getElementById('projects');
  var slider  = document.getElementById('dev-slider');
  if (!section || !slider) return;
  var slides  = [].slice.call(slider.querySelectorAll('.dev-slide'));
  if (slides.length < 2) return;

  var prevBtn = section.querySelector('.dev-nav-prev');
  var nextBtn = section.querySelector('.dev-nav-next');
  var curEl   = section.querySelector('.dev-nav-cur');
  var totEl   = section.querySelector('.dev-nav-total');

  var AUTO_MS = 8000;
  var mqlReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduce() { return !!(mqlReduce && mqlReduce.matches); }

  var idx = 0, timer = null;
  var hovering = false, focusing = false, locked = false, inView = false;

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  var OFFSET = 46;        /* px of restrained lateral drift per transition */
  var pendingRaf = null;  /* guards the settle-frame against rapid navigation */

  function render(dir) {
    dir = dir || 0;
    if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = null; }

    slides.forEach(function (s, k) {
      s.setAttribute('aria-hidden', (k === idx) ? 'false' : 'true');
    });

    if (dir === 0 || reduce()) {
      /* Initial paint or reduced motion → straight crossfade, no lateral drift */
      slides.forEach(function (s, k) {
        s.style.transform = '';
        s.classList.toggle('is-active', k === idx);
      });
    } else {
      var incoming = slides[idx];
      /* Outgoing (currently active) slide drifts out opposite the travel dir
         while it fades — its transition is already live, so setting the target
         offset animates it. Every other slide rests centred and hidden. */
      slides.forEach(function (s, k) {
        if (k === idx) return;
        s.style.transform = s.classList.contains('is-active')
          ? 'translateX(' + (dir > 0 ? -OFFSET : OFFSET) + 'px)'
          : 'translateX(0)';
        s.classList.remove('is-active');
      });
      /* Incoming enters from the travel direction, then settles to centre —
         one project dominant at a time, slow lateral drift + opacity crossfade.
         The start offset is applied with the transition momentarily disabled
         (a FLIP) so it doesn't animate into place; the drift-to-centre then
         animates on the next frame while opacity crossfades via .is-active. */
      incoming.style.transition = 'none';
      incoming.style.transform = 'translateX(' + (dir > 0 ? OFFSET : -OFFSET) + 'px)';
      void incoming.offsetWidth;                   /* commit offset instantly  */
      incoming.style.transition = '';              /* restore CSS transitions  */
      incoming.classList.add('is-active');          /* opacity 0 → 1 crossfade  */
      pendingRaf = requestAnimationFrame(function () {
        pendingRaf = null;
        incoming.style.transform = 'translateX(0)'; /* drift 46px → centre      */
      });
    }

    if (curEl) curEl.textContent = pad(idx + 1);
    if (totEl) totEl.textContent = pad(slides.length);
  }
  function go(i, dir) { idx = (i + slides.length) % slides.length; render(dir); }
  function next() { go(idx + 1, 1); }
  function prev() { go(idx - 1, -1); }

  function canAuto() {
    return inView && !hovering && !focusing && !locked && !document.hidden && !reduce();
  }
  function stopAuto() { if (timer) { clearInterval(timer); timer = null; } }
  function startAuto() {
    stopAuto();
    if (!canAuto()) return;
    timer = setInterval(function () { if (canAuto()) next(); else stopAuto(); }, AUTO_MS);
  }

  /* Manual controls */
  if (nextBtn) nextBtn.addEventListener('click', function () { next(); startAuto(); });
  if (prevBtn) prevBtn.addEventListener('click', function () { prev(); startAuto(); });

  /* Pause while the visitor is engaging with the current project */
  slider.addEventListener('pointerenter', function () { hovering = true; stopAuto(); });
  slider.addEventListener('pointerleave', function () { hovering = false; startAuto(); });
  slider.addEventListener('focusin',  function () { focusing = true; stopAuto(); });
  slider.addEventListener('focusout', function (e) {
    if (!slider.contains(e.relatedTarget)) { focusing = false; startAuto(); }
  });

  /* Keyboard navigation */
  section.addEventListener('keydown', function (e) {
    if (locked) return;
    if (e.key === 'ArrowLeft')  { prev(); startAuto(); }
    else if (e.key === 'ArrowRight') { next(); startAuto(); }
  });

  /* Touch swipe — gesture only (cross-dissolve, no finger-follow translate) */
  var tsx = 0, tsy = 0, touching = false;
  slider.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0]; tsx = t.clientX; tsy = t.clientY; touching = true; stopAuto();
  }, { passive: true });
  slider.addEventListener('touchend', function (e) {
    if (!touching) return; touching = false;
    var t = e.changedTouches[0], dx = t.clientX - tsx, dy = t.clientY - tsy;
    if (!locked && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0) next(); else prev();
    }
    startAuto();
  }, { passive: true });

  /* Tab visibility */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopAuto(); else startAuto();
  });

  /* Only run (and keep Mahogany Row first) once the slider is on-screen */
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        inView = en.isIntersecting;
        if (inView) startAuto(); else stopAuto();
      });
    }, { threshold: 0.35 });
    io.observe(slider);
  } else { inView = true; startAuto(); }

  /* Lock hook — the Mahogany Row explore module freezes the slider while a
     project experience is open, then releases it (same slide) on exit. */
  window.kvfSliderLock = function (l) {
    locked = !!l;
    section.classList.toggle('slider-locked', locked);
    if (locked) stopAuto(); else startAuto();
  };

  if (mqlReduce && mqlReduce.addEventListener) {
    mqlReduce.addEventListener('change', function () { if (reduce()) stopAuto(); else startAuto(); });
  }

  render();
})();
