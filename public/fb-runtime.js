// ตัวเชื่อมหน้าเว็บกับ Firebase
// หน้า index.html เดิมเขียนไว้ให้ใช้ window.claude.use("db" | "user" | "downloads")
// ไฟล์นี้สร้าง API ชุดเดียวกันบน Firestore + Firebase Auth เพื่อให้หน้าเว็บทำงานได้โดยแก้น้อยที่สุด
//
// ผังข้อมูลใน Firestore
//   app/state            ข้อมูลออเดอร์ทั้งหมด (ทุกคนอ่านและแก้ได้) เบอร์โทรถูกซ่อนเป็น ••••
//   phones/{sid}         เบอร์โทรจริงของสมาชิก (ทุกคนเขียนได้ อ่านได้เฉพาะแอดมิน)
//   media_public/{id}    รูป QR ชำระเงิน (ทุกคนอ่านได้ แอดมินเขียน)
//   media_private/{id}   รูปสลิป (ทุกคนเขียนได้ อ่านได้เฉพาะแอดมิน)
//   backups/{id}         สำเนา app/state ทุก 10 นาที (เพิ่มได้อย่างเดียว อ่านได้เฉพาะแอดมิน)
//
// แอดมิน = ผู้ที่ล็อกอินด้วย Google ด้วยอีเมลใน ADMIN_EMAILS (ต้องตรงกับ firestore.rules)
(function(){
  "use strict";

  const SDK = "https://www.gstatic.com/firebasejs/10.14.1/";
  const CONFIG = {
    apiKey: "AIzaSyA7-Q650ZRYF4DoJzh48d_c84XAwUMthM0",
    authDomain: "uniform-order-da59c.firebaseapp.com",
    projectId: "uniform-order-da59c",
    storageBucket: "uniform-order-da59c.firebasestorage.app",
    messagingSenderId: "351494171092",
    appId: "1:351494171092:web:cf0a27ddcd52ef2edcce41"
  };
  // อีเมลแอดมิน ต้องแก้ให้ตรงกับรายการใน firestore.rules
  const ADMIN_EMAILS = [];

  const MASK = "••••••";
  const BACKUP_EVERY_MS = 10 * 60 * 1000;
  const params = new URLSearchParams(location.search);
  const useEmulator = params.has("emulator") || location.hostname === "localhost" || location.hostname === "127.0.0.1";

  function digits(p){ return String(p || "").replace(/\D/g, ""); }
  function maskPhone(p){
    const d = digits(p);
    return d ? MASK + d.slice(-2) : "";
  }
  function isMasked(p){ return String(p || "").includes("•"); }

  let fs = null, authMod = null, db = null, auth = null, user = null, admin = false;

  const ready = (async () => {
    const [appMod, fsMod, aMod] = await Promise.all([
      import(SDK + "firebase-app.js"),
      import(SDK + "firebase-firestore.js"),
      import(SDK + "firebase-auth.js")
    ]);
    fs = fsMod; authMod = aMod;
    const app = appMod.initializeApp(CONFIG);
    db = fs.initializeFirestore(app, { ignoreUndefinedProperties: true });
    auth = aMod.getAuth(app);
    if (useEmulator){
      fs.connectFirestoreEmulator(db, location.hostname || "127.0.0.1", 8080);
      aMod.connectAuthEmulator(auth, "http://" + (location.hostname || "127.0.0.1") + ":9099", { disableWarnings: true });
    }
    user = await new Promise(res => {
      const off = aMod.onAuthStateChanged(auth, u => { off(); res(u); });
    });
    // ใช้ทดสอบกับ Emulator ในเครื่องเท่านั้น: ?testUser=อีเมล
    if (useEmulator && params.get("testUser") && !user){
      const email = params.get("testUser"), pw = "test-only-123";
      try{ user = (await aMod.signInWithEmailAndPassword(auth, email, pw)).user; }
      catch(e){ user = (await aMod.createUserWithEmailAndPassword(auth, email, pw)).user; }
    }
    admin = !!(user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()));
    addAdminControls();
    return makeApi();
  })();

  /* ---------- db: เลียนแบบ API ของ window.claude.use("db") ---------- */
  function makeApi(){
    // เบอร์จริงที่รู้อยู่ (แอดมินอ่านจาก phones/, ทุกคนรู้เบอร์ที่ตัวเองพิมพ์)
    const knownPhone = {};
    let lastState = null;          // ข้อมูลดิบล่าสุดจาก app/state
    let stateListeners = [];
    let lastBackup = 0;

    function emitState(){
      if (!lastState) return;
      const snap = lastState;
      const data = snap.exists() ? snap.data() : null;
      if (data && admin) mergePhones(data);
      const wrapped = {
        exists: snap.exists(),
        metadata: { fromCache: snap.metadata.fromCache },
        data: () => data ? JSON.parse(JSON.stringify(data)) : undefined
      };
      stateListeners.forEach(fn => fn(wrapped));
    }
    function mergePhones(data){
      (data.orders || []).forEach(o => (o.students || []).forEach(s => {
        if (s.sid && knownPhone[s.sid] !== undefined) s.phone = knownPhone[s.sid];
      }));
    }

    // แยกเบอร์โทรออกจากข้อมูลก่อนบันทึก
    async function writeState(data){
      const pub = JSON.parse(JSON.stringify(data));
      const phoneWrites = [];
      (pub.orders || []).forEach(o => (o.students || []).forEach(s => {
        const p = s.phone || "";
        if (isMasked(p)){
          // ค่าที่ซ่อนไว้ ไม่ได้แก้ คงค่าเดิม
          return;
        }
        if (s.sid && knownPhone[s.sid] !== p && (p || knownPhone[s.sid])){
          knownPhone[s.sid] = p;
          phoneWrites.push(fs.setDoc(fs.doc(db, "phones", s.sid), { phone: p, at: fs.serverTimestamp() }));
        }
        s.phone = maskPhone(p);
        s.phoneOk = digits(p).length >= 9;
      }));
      await Promise.all(phoneWrites);
      await fs.setDoc(fs.doc(db, "app", "state"), pub);
      if (Date.now() - lastBackup > BACKUP_EVERY_MS){
        lastBackup = Date.now();
        fs.addDoc(fs.collection(db, "backups"), { orders: pub.orders, at: fs.serverTimestamp(), by: admin ? (user.email || "admin") : "member" })
          .catch(() => {});
      }
    }

    function mediaColl(id){ return String(id).startsWith("qr-") ? "media_public" : "media_private"; }

    function docRef(path){
      const [coll, id] = String(path).split("/");
      if (coll === "app" && id === "state"){
        return {
          set: data => writeState(data),
          delete: () => fs.deleteDoc(fs.doc(db, "app", "state")),
          onSnapshot(cb, err){
            stateListeners.push(cb);
            if (stateListeners.length === 1){
              fs.onSnapshot(fs.doc(db, "app", "state"), { includeMetadataChanges: false }, s => { lastState = s; emitState(); }, err);
              if (admin){
                fs.onSnapshot(fs.collection(db, "phones"), qs => {
                  qs.docs.forEach(d => { knownPhone[d.id] = (d.data() || {}).phone || ""; });
                  emitState();
                }, () => {});
              }
            } else if (lastState) emitState();
            return () => { stateListeners = stateListeners.filter(f => f !== cb); };
          }
        };
      }
      if (coll === "media"){
        return {
          set: data => fs.setDoc(fs.doc(db, mediaColl(id), id), data),
          delete: () => fs.deleteDoc(fs.doc(db, mediaColl(id), id))
        };
      }
      throw new Error("unsupported doc " + path);
    }

    function collectionRef(name){
      if (name !== "media") throw new Error("unsupported collection " + name);
      return {
        onSnapshot(cb, err){
          const parts = { media_public: null, media_private: admin ? null : [] };
          const send = () => {
            if (parts.media_public === null || parts.media_private === null) return;
            cb({ docs: [...parts.media_public, ...parts.media_private] });
          };
          const wrap = qs => qs.docs.map(d => ({ id: d.id, data: () => d.data() }));
          const offs = [fs.onSnapshot(fs.collection(db, "media_public"), qs => { parts.media_public = wrap(qs); send(); }, err)];
          if (admin) offs.push(fs.onSnapshot(fs.collection(db, "media_private"), qs => { parts.media_private = wrap(qs); send(); }, err));
          return () => offs.forEach(f => f());
        }
      };
    }

    return {
      db: { doc: docRef, collection: collectionRef },
      user: { isOwner: () => admin, email: user && user.email },
      downloads: {
        async save({ filename, data }){
          const blob = data instanceof Blob ? data : new Blob([data]);
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = filename;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
      },
      importState
    };
  }

  /* ---------- นำเข้าข้อมูลจากไฟล์ JSON (แอดมินเท่านั้น) ---------- */
  // รูปแบบไฟล์: { "state": { "orders": [...] }, "media": { "qr-o1": "data:...", "slip-xxx": "data:..." } }
  async function importState(file){
    const api = await ready;
    const json = JSON.parse(await file.text());
    const media = json.media || {};
    for (const [id, data] of Object.entries(media)){
      if (typeof data === "string" && data.startsWith("data:")) await api.db.doc("media/" + id).set({ data });
    }
    const orders = (json.state && json.state.orders) || json.orders;
    if (!Array.isArray(orders) || !orders.length) throw new Error("ไม่พบข้อมูลออเดอร์ในไฟล์");
    await api.db.doc("app/state").set({ orders });
    return orders.reduce((n, o) => n + (o.students || []).length, 0);
  }

  /* ---------- ปุ่มเข้าสู่ระบบแอดมิน ---------- */
  function addAdminControls(){
    const place = () => {
      const tools = document.getElementById("topTools");
      if (!tools) return;
      const mk = (text, fn) => {
        const b = document.createElement("button");
        b.className = "btn";
        b.style.cssText = "min-height:36px;padding:6px 12px;font-size:.85rem;margin-left:8px";
        b.textContent = text;
        b.addEventListener("click", fn);
        tools.appendChild(b);
        return b;
      };
      const status = t => { const s = document.getElementById("status"); if (s) s.textContent = t; };
      if (!user){
        const b = mk("แอดมินเข้าสู่ระบบ", async () => {
          try{
            await authMod.signInWithPopup(auth, new authMod.GoogleAuthProvider());
            location.reload();
          }catch(e){ status("เข้าสู่ระบบไม่สำเร็จ: " + (e.code || e.message)); }
        });
        b.style.opacity = ".7";
        return;
      }
      if (!admin){
        status("บัญชี " + (user.email || "") + " ไม่ใช่แอดมิน");
      }
      if (admin){
        const input = document.createElement("input");
        input.type = "file"; input.accept = "application/json,.json"; input.hidden = true;
        tools.appendChild(input);
        input.addEventListener("change", async () => {
          const f = input.files && input.files[0];
          input.value = "";
          if (!f) return;
          if (!confirm("นำเข้าข้อมูลจากไฟล์นี้ และแทนที่ข้อมูลทั้งหมดที่มีอยู่ใช่ไหม")) return;
          try{
            const n = await importState(f);
            status("นำเข้าข้อมูลแล้ว " + n + " คน");
          }catch(e){ status("นำเข้าไม่สำเร็จ: " + (e.message || e.code)); }
        });
        mk("นำเข้าข้อมูล", () => input.click());
      }
      mk("ออกจากระบบ", async () => { await authMod.signOut(auth); location.reload(); });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", place);
    else place();
  }

  window.claude = {
    use(name){
      return ready.then(api => {
        if (!api[name]) throw Object.assign(new Error("unsupported " + name), { code: "unsupported" });
        return api[name];
      });
    }
  };
})();
