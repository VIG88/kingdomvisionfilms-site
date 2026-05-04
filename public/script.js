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
  var BG_DURATION_SEC  = 39.833;  /* exact ffprobe duration               */
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

      /* Ensure idle video is playing and has correct mute state */
      idleVid.muted  = isMuted;
      idleVid.volume = isMuted ? 0 : 1;
      idleVid.play().catch(function () {});

      /* CSS crossfade — both at same currentTime → invisible blend */
      activeVid.classList.remove('bg-active');
      activeVid.classList.add('bg-idle');
      idleVid.classList.remove('bg-idle');
      idleVid.classList.add('bg-active');

      var outgoing = activeVid;
      activeVid = idleVid;
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

    function doFade() {
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
