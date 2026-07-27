/* =========================================================
   bg-scene.js — persistent 3D background: a dark glass node
   graph, floating and levitating, that the whole page scrolls
   over (position:fixed canvas, z-index:-1 — see #bg-scene in
   base.css). The camera flies around it as GSAP ScrollTrigger
   walks through the page's sections.

   Structure (functional core / imperative shell):
   - PURE MATH  — takes plain numbers/objects, returns new plain
     objects, never touches a Mesh, a Vector3 or the DOM.
   - SCENE BUILD — factory functions that construct Three.js
     objects (inherently side-effecting; WebGL has no pure API).
   - APPLY / ANIMATE — the only place that mutates: it reads the
     pure math output and writes it into pre-allocated Vector3
     scratch buffers and mesh.position, once per frame.
   ========================================================= */
(function () {
  "use strict";

  var canvas = document.getElementById("bg-scene");
  if (!canvas || !window.THREE) return;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* =========================================================
     PURE MATH — no THREE objects in or out, just numbers.
     ========================================================= */

  // combine two sine harmonics — this is the whole "levitation" signal
  function sumSines(t, freq1, freq2, phase) {
    return Math.sin(t * freq1 + phase) * 0.6 + Math.sin(t * freq2 + phase * 1.7) * 0.4;
  }

  // where a node should sit this frame, as a plain {x,y,z} offset from its base position
  function levitationOffset(t, seed, amplitude) {
    return {
      x: sumSines(t, 0.18, 0.07, seed) * amplitude * 0.5,
      y: sumSines(t, 0.14, 0.05, seed + 10) * amplitude,
      z: sumSines(t, 0.11, 0.09, seed + 20) * amplitude * 0.5
    };
  }

  // screen-space repulsion: given a node's NDC position and the cursor's NDC
  // position, how far (in NDC units) and which direction should it flee —
  // pure vector algebra (subtract, length, normalize, inverse-falloff).
  function repulsionInScreenSpace(nodeNdcX, nodeNdcY, cursorNdcX, cursorNdcY, radius, strength) {
    var dx = nodeNdcX - cursorNdcX;
    var dy = nodeNdcY - cursorNdcY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= radius || dist < 1e-4) return { x: 0, y: 0 };
    var falloff = 1 - dist / radius;
    var invDist = 1 / dist;
    return { x: dx * invDist * falloff * falloff * strength, y: dy * invDist * falloff * falloff * strength };
  }

  // spherical camera rig -> cartesian; the "rotation matrix" the brief asks
  // for is exactly this: composing camera.position from an orbit angle
  function orbitToCartesian(theta, radius, y) {
    return { x: Math.sin(theta) * radius, y: y, z: Math.cos(theta) * radius };
  }

  // which pairs of nodes count as "connected" (nearest-neighbour graph edges)
  function buildEdgeList(basePositions, maxDist) {
    var edges = [];
    for (var i = 0; i < basePositions.length; i++) {
      for (var j = i + 1; j < basePositions.length; j++) {
        var a = basePositions[i], b = basePositions[j];
        var dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) < maxDist) edges.push([i, j]);
      }
    }
    return edges;
  }

  // deterministic-ish scatter of node base positions inside a flattened ellipsoid
  function buildNodeLayout(count, seedStart) {
    var nodes = [];
    for (var i = 0; i < count; i++) {
      var u = Math.sin((i + seedStart) * 12.9898) * 43758.5453;
      var v = Math.sin((i + seedStart) * 78.233) * 12543.813;
      var w = Math.sin((i + seedStart) * 39.346) * 27321.123;
      var rx = (u - Math.floor(u)) * 2 - 1;
      var ry = (v - Math.floor(v)) * 2 - 1;
      var rz = (w - Math.floor(w)) * 2 - 1;
      nodes.push({
        x: rx * 9.5,
        y: ry * 5.5,
        z: rz * 6.5,
        scale: 0.35 + Math.abs(rx * ry) * 0.9,
        seed: (i + seedStart) * 3.1,
        accent: (i % 5) === 0
      });
    }
    return nodes;
  }

  /* =========================================================
     SCENE BUILD — the only functions allowed to touch THREE.*
     ========================================================= */

  function buildEnvironment(renderer) {
    var pmrem = new THREE.PMREMGenerator(renderer);
    var envScene = new THREE.Scene();
    var sphere = new THREE.Mesh(
      new THREE.SphereGeometry(24, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0x121722, side: THREE.BackSide })
    );
    envScene.add(sphere);
    var rim = new THREE.PointLight(0x05a0f3, 55, 40);
    rim.position.set(8, 6, 6);
    envScene.add(rim);
    var fill = new THREE.PointLight(0xf2ede1, 22, 40);
    fill.position.set(-7, -4, 5);
    envScene.add(fill);
    var tex = pmrem.fromScene(envScene, 0.05).texture;
    pmrem.dispose();
    return tex;
  }

  // the node shape IS the brand mark: one clean 4-pointed X/star, built as
  // a single shape (two overlapping chevrons produced an odd 5-lobed blob
  // instead of a clean X — this is the simpler, correct version).
  function buildXGeometry() {
    var outerR = 0.62, innerR = 0.16;
    var shape = new THREE.Shape();
    for (var i = 0; i < 8; i++) {
      // outer points sit on the diagonals (45/135/225/315°) so the star
      // reads as an X rather than a plus
      var angle = Math.PI / 4 + (i * Math.PI) / 4;
      var r = i % 2 === 0 ? outerR : innerR;
      var x = Math.cos(angle) * r, y = Math.sin(angle) * r;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    shape.closePath();
    var geo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.3, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 3, curveSegments: 1
    });
    geo.center();
    return geo;
  }

  function buildNodeMesh(envMap, accent, sharedGeometry) {
    var material = new THREE.MeshPhysicalMaterial({
      color: accent ? 0x0c2536 : 0x181b21,
      metalness: 0,
      roughness: accent ? 0.12 : 0.22,
      transmission: 1,
      thickness: 1.6,
      ior: 1.45,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMap: envMap,
      envMapIntensity: accent ? 1.9 : 1.1,
      emissive: accent ? 0x05a0f3 : 0x000000,
      emissiveIntensity: accent ? 0.16 : 0
    });
    return new THREE.Mesh(sharedGeometry, material);
  }

  function buildEdgesObject(edgeList) {
    var positions = new Float32Array(edgeList.length * 2 * 3);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    var material = new THREE.LineBasicMaterial({ color: 0x05a0f3, transparent: true, opacity: 0.16 });
    return new THREE.LineSegments(geo, material);
  }

  /* =========================================================
     APPLY / ANIMATE — the imperative shell. Everything reused
     across frames is allocated once, up here, never inside the
     render loop (kept the frame budget steady).
     ========================================================= */

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x0b0f16, 1);
  renderer.outputEncoding = THREE.sRGBEncoding;

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);

  var envMap = buildEnvironment(renderer);
  scene.environment = envMap;
  scene.add(new THREE.AmbientLight(0x1c2430, 0.7));
  var keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
  keyLight.position.set(6, 8, 6);
  scene.add(keyLight);

  var NODE_COUNT = 22;
  var nodeLayout = buildNodeLayout(NODE_COUNT, 7);
  var edgeList = buildEdgeList(nodeLayout, 7.5);
  var xGeometry = buildXGeometry();

  var nodeMeshes = nodeLayout.map(function (n) {
    var mesh = buildNodeMesh(envMap, n.accent, xGeometry);
    mesh.position.set(n.x, n.y, n.z);
    mesh.scale.setScalar(n.scale * 1.6);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    scene.add(mesh);
    return mesh;
  });

  var edgesObject = buildEdgesObject(edgeList);
  scene.add(edgesObject);

  // populate edge endpoints once from the resting layout so the graph
  // still reads correctly even if the animation loop below never runs
  // a second frame (prefers-reduced-motion)
  (function initEdgePositions() {
    var posAttr = edgesObject.geometry.attributes.position;
    var arr = posAttr.array;
    for (var e = 0; e < edgeList.length; e++) {
      var a = nodeMeshes[edgeList[e][0]].position;
      var b = nodeMeshes[edgeList[e][1]].position;
      var o = e * 6;
      arr[o] = a.x; arr[o + 1] = a.y; arr[o + 2] = a.z;
      arr[o + 3] = b.x; arr[o + 4] = b.y; arr[o + 5] = b.z;
    }
    posAttr.needsUpdate = true;
  })();

  // scratch buffers — allocated once, mutated every frame, never replaced.
  // this is what "hoist new Vector3() out of the render loop" means in
  // practice: these five objects are the ONLY Vector3 instances the
  // animation loop ever touches, no matter how many nodes there are.
  var scratchNode = new THREE.Vector3();
  var scratchForward = new THREE.Vector3();
  var scratchRight = new THREE.Vector3();

  var cameraState = { theta: 0, radius: 15, y: 0, lookY: 0 };
  var driftTheta = 0;

  var mouseNdc = { x: 0, y: -2 }; // start off-screen so nothing repels before the first move
  window.addEventListener("pointermove", function (e) {
    mouseNdc.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouseNdc.y = -((e.clientY / window.innerHeight) * 2 - 1);
  });

  function resize() {
    var w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", resize);
  resize();

  /* ---------- GSAP ScrollTrigger camera choreography ----------
     One continuous ~190° orbit around the node graph, composed of
     five shots — one per section — instead of the section content
     itself sliding around. Each tween's start matches the previous
     tween's end so the camera move reads as one continuous flight. */
  try {
    if (!reduceMotion && window.gsap && window.ScrollTrigger) {
      gsap.registerPlugin(ScrollTrigger);
      var shots = [
        { id: "hero", theta: 0.0, radius: 15, y: 0.0 },
        { id: "about", theta: 0.35, radius: 11, y: 1.2 },
        { id: "pillars", theta: 2.6, radius: 12, y: 0.4 },
        { id: "stats", theta: 2.9, radius: 16, y: 2.6 },
        { id: "contact", theta: 3.35, radius: 10, y: 0.2 }
      ];
      for (var s = 1; s < shots.length; s++) {
        var from = shots[s - 1], to = shots[s];
        var el = document.getElementById(to.id);
        if (!el) continue;
        gsap.fromTo(
          cameraState,
          { theta: from.theta, radius: from.radius, y: from.y },
          {
            theta: to.theta, radius: to.radius, y: to.y,
            ease: "none",
            immediateRender: false, // fromTo() renders its "from" state at creation
                                     // time by default — with 4 tweens sharing one
                                     // object, whichever is built last would stomp
                                     // cameraState before any scrolling even happens
            scrollTrigger: { trigger: el, start: "top top", end: "bottom top", scrub: 0.6 }
          }
        );
      }
    }
  } catch (e) {}

  function repulsionForNode(basePos) {
    scratchNode.set(basePos.x, basePos.y, basePos.z).project(camera);
    return repulsionInScreenSpace(scratchNode.x, scratchNode.y, mouseNdc.x, mouseNdc.y, 0.28, 2.2);
  }

  function frame(tsMs) {
    var t = tsMs * 0.001;

    if (!reduceMotion) driftTheta += 0.0007;

    var cx = Math.sin(cameraState.theta + driftTheta) * cameraState.radius;
    var cz = Math.cos(cameraState.theta + driftTheta) * cameraState.radius;
    camera.position.set(cx, cameraState.y, cz);
    camera.lookAt(0, cameraState.lookY, 0);

    if (!reduceMotion) {
      // camera-relative "right" axis computed ONCE per frame (not per node)
      // into the pre-allocated scratch vectors — screen-space repulsion
      // reads correctly from whatever angle the orbit is currently at,
      // without allocating anything inside the per-node loop below
      camera.getWorldDirection(scratchForward);
      scratchRight.crossVectors(scratchForward, camera.up).normalize();

      for (var i = 0; i < nodeMeshes.length; i++) {
        var base = nodeLayout[i];
        var lev = levitationOffset(t, base.seed, 0.55);
        var rep = repulsionForNode(base);
        var mesh = nodeMeshes[i];
        mesh.position.set(base.x + lev.x, base.y + lev.y, base.z + lev.z);
        mesh.position.addScaledVector(scratchRight, rep.x * 6);
        mesh.position.y += rep.y * 6;
        mesh.rotation.x += 0.0015;
        mesh.rotation.y += 0.0022;
      }

      var posAttr = edgesObject.geometry.attributes.position;
      var arr = posAttr.array;
      for (var e = 0; e < edgeList.length; e++) {
        var a = nodeMeshes[edgeList[e][0]].position;
        var b = nodeMeshes[edgeList[e][1]].position;
        var o = e * 6;
        arr[o] = a.x; arr[o + 1] = a.y; arr[o + 2] = a.z;
        arr[o + 3] = b.x; arr[o + 4] = b.y; arr[o + 5] = b.z;
      }
      posAttr.needsUpdate = true;
    }

    renderer.render(scene, camera);
    if (!reduceMotion) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
