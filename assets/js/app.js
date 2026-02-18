/* ═══════════════════════════════════════════════════════════
   LOCATAIRE PRO — app.js
   Module ES6 — Firebase Auth + Firestore + PDF + Analytics
═══════════════════════════════════════════════════════════ */

// ── Utils ──────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function uid() {
  return (window.crypto?.randomUUID?.())
    ?? ("id_" + Math.random().toString(16).slice(2) + "_" + Date.now());
}

function euro(n) {
  return Number(n || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function toISODate(d) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatFRDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString("fr-FR", {
    day: "2-digit", month: "long", year: "numeric"
  });
}

function monthLabel(year, mi) {
  return new Date(year, mi, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function safeFileName(name) {
  return String(name || "document")
    .replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, "_").slice(0, 180);
}

function normalizeAdjustments(adjs) {
  return (Array.isArray(adjs) ? adjs : [])
    .map(a => ({ label: String(a?.label ?? "").trim(), amount: Number(a?.amount ?? 0) }))
    .filter(a => a.label);
}

function ymKey(year, month) { return Number(year) * 12 + Number(month); }

// ── Toast ──────────────────────────────────────────────────
function toast(msg, type = "default") {
  const container = $("#toastContainer");
  if (!container) return;
  const el = document.createElement("div");
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.animation = "toastOut .3s ease forwards";
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ── State ──────────────────────────────────────────────────
const STORAGE_KEY = "locataire_pro_v1";
const LEGACY_KEY  = "quittances_state_v3";   // ancienne clé

const defaultState = {
  landlord: { fullName: "", address: "", email: "", phone: "", city: "", signatureName: "" },
  tenants: [],
  receipts: [],
  payments: []   // nouveau : suivi paiements mois par mois
};

function normalizeState(data) {
  const landlord = { ...defaultState.landlord, ...(data?.landlord || {}) };

  const tenants = (Array.isArray(data?.tenants) ? data.tenants : []).map(t => {
    const tenant = { ...t };
    tenant.id = tenant.id || uid();
    tenant.fullName = tenant.fullName || "";
    tenant.tenantAddress = tenant.tenantAddress || "";
    tenant.paymentMethod = tenant.paymentMethod || "Virement";

    if (!Array.isArray(tenant.properties)) {
      tenant.properties = [{
        id: uid(), label: "Logement 1",
        address: tenant.propertyAddress || "",
        rentHc: Number(tenant.rentHc || 0),
        charges: Number(tenant.charges || 0)
      }];
      delete tenant.propertyAddress;
      delete tenant.rentHc;
      delete tenant.charges;
    }

    tenant.properties = tenant.properties.map(p => ({
      id: p.id || uid(),
      label: String(p.label || "Logement").trim() || "Logement",
      address: String(p.address || "").trim(),
      rentHc: Number(p.rentHc || 0),
      charges: Number(p.charges || 0)
    }));

    return tenant;
  });

  const receipts = (Array.isArray(data?.receipts) ? data.receipts : []).map(r => ({
    id: r.id || uid(),
    tenantId: r.tenantId || "",
    tenantName: r.tenantName || "",
    tenantAddress: r.tenantAddress || "",
    propertyId: r.propertyId || "",
    propertyLabel: r.propertyLabel || "",
    propertyAddress: r.propertyAddress || "",
    year: Number(r.year || new Date().getFullYear()),
    month: Number(r.month ?? 0),
    period: r.period || "",
    reference: r.reference || "",
    dateIssued: r.dateIssued || toISODate(new Date()),
    rentHc: Number(r.rentHc || 0),
    charges: Number(r.charges || 0),
    adjustments: normalizeAdjustments(r.adjustments),
    total: Number(r.total || 0),
    paymentMethod: r.paymentMethod || "Virement",
    createdAt: Number(r.createdAt || Date.now())
  }));

  // payments: {id, tenantId, propertyId, year, month, status, note, updatedAt}
  const payments = (Array.isArray(data?.payments) ? data.payments : []).map(p => ({
    id: p.id || uid(),
    tenantId: p.tenantId || "",
    propertyId: p.propertyId || "",
    year: Number(p.year || 0),
    month: Number(p.month ?? 0),
    status: p.status || "pending",  // paid | pending | late
    note: p.note || "",
    updatedAt: p.updatedAt || Date.now()
  }));

  return { landlord, tenants, receipts, payments };
}

// ── Local storage + legacy migration ───────────────────────
function loadLocal() {
  try {
    // 1. Try new key
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));

    // 2. Try legacy key → migrate
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const migrated = normalizeState(JSON.parse(legacy));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch { /**/ }
  return structuredClone(defaultState);
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    landlord: state.landlord,
    tenants: state.tenants,
    receipts: state.receipts,
    payments: state.payments
  }));
}

let state = loadLocal();

// ── Cloud (Firebase) ───────────────────────────────────────
const FB_VER = "10.12.2";
const FB_CFG = window.FIREBASE_CONFIG || null;

let cloud = { enabled: false, auth: null, db: null, user: null, unsub: null, applying: false };

function setCloudBadge(text, status = "default") {
  const el = $("#cloudBadge");
  if (!el) return;
  el.className = `cloud-badge ${status}`;
  $("#cloudBadgeText").textContent = text;
}

async function cloudWrite(db, userId, timestamp) {
  const { doc, setDoc } = await import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-firestore.js`);
  const ref = doc(db, "users", userId, "app", "state");
  await setDoc(ref, {
    landlord: state.landlord,
    tenants: state.tenants,
    receipts: state.receipts,
    payments: state.payments,
    updatedAt: timestamp
  }, { merge: true });
}

async function saveState() {
  saveLocal();
  if (typeof window.__cloudSave === "function" && !cloud.applying) {
    try { await window.__cloudSave(); } catch { /**/ }
  }
}

async function initFirebase() {
  if (!FB_CFG?.apiKey || FB_CFG.apiKey.includes("...")) {
    setCloudBadge("Cloud non configuré", "");
    return;
  }

  try {
    const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-app.js`);
    const { getAuth, onAuthStateChanged, signInWithEmailAndPassword,
            createUserWithEmailAndPassword, sendEmailVerification,
            signOut, sendPasswordResetEmail, reload }
      = await import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-auth.js`);
    const { getFirestore, doc, getDoc, onSnapshot, serverTimestamp }
      = await import(`https://www.gstatic.com/firebasejs/${FB_VER}/firebase-firestore.js`);

    const app = initializeApp(FB_CFG);
    cloud.auth = getAuth(app);
    cloud.db   = getFirestore(app);
    cloud.enabled = true;

    // ── Auth UI handlers ──────────────────────────────────
    const showAuthForm = (id) => {
      $$(".auth-form").forEach(f => f.classList.remove("active"));
      $(`#${id}`)?.classList.add("active");
    };

    // Navigation
    $("#goRegister")?.addEventListener("click", e => { e.preventDefault(); showAuthForm("registerForm"); });
    $("#goLogin")?.addEventListener("click",    e => { e.preventDefault(); showAuthForm("loginForm"); });
    $("#goLogin2")?.addEventListener("click",   e => { e.preventDefault(); showAuthForm("loginForm"); });
    $("#goForgot")?.addEventListener("click",   e => { e.preventDefault(); showAuthForm("forgotForm"); });

    // Password toggle
    $$(".pass-toggle").forEach(btn => {
      btn.addEventListener("click", () => {
        const inp = $(`#${btn.dataset.target}`);
        if (!inp) return;
        inp.type = inp.type === "password" ? "text" : "password";
      });
    });

    // Login
    const setMsg = (id, msg, ok = false) => {
      const el = $(`#${id}`);
      if (!el) return;
      el.textContent = msg;
      el.className = `auth-msg${ok ? " success" : ""}`;
    };

    $("#btnLogin")?.addEventListener("click", async () => {
      setMsg("loginMsg", "");
      const email = $("#login_email").value.trim();
      const pass  = $("#login_pass").value;
      if (!email || !pass) { setMsg("loginMsg", "Email et mot de passe requis."); return; }
      try {
        const { user } = await signInWithEmailAndPassword(cloud.auth, email, pass);
        if (!user.emailVerified) {
          showAuthForm("verifyForm");
          $("#verifyEmailText").textContent = `Votre email (${email}) n'est pas encore vérifié.`;
        }
      } catch (e) {
        setMsg("loginMsg", friendlyAuthError(e.code));
      }
    });

    // Register
    $("#btnRegister")?.addEventListener("click", async () => {
      setMsg("registerMsg", "");
      const email = $("#reg_email").value.trim();
      const pass  = $("#reg_pass").value;
      const pass2 = $("#reg_pass2").value;
      if (!email) { setMsg("registerMsg", "Email requis."); return; }
      if (pass.length < 8) { setMsg("registerMsg", "Mot de passe : 8 caractères minimum."); return; }
      if (pass !== pass2)  { setMsg("registerMsg", "Les mots de passe ne correspondent pas."); return; }
      try {
        const { user } = await createUserWithEmailAndPassword(cloud.auth, email, pass);
        await sendEmailVerification(user);
        showAuthForm("verifyForm");
        $("#verifyEmailText").textContent = `Un email de vérification a été envoyé à ${email}.`;
        setMsg("verifyMsg", "Email envoyé ! Consultez votre boîte.", true);
      } catch (e) {
        setMsg("registerMsg", friendlyAuthError(e.code));
      }
    });

    // Verify email check
    $("#btnCheckVerif")?.addEventListener("click", async () => {
      setMsg("verifyMsg", "Vérification...");
      try {
        await reload(cloud.auth.currentUser);
        if (cloud.auth.currentUser?.emailVerified) {
          hideAuthOverlay();
          toast("Email vérifié — Bienvenue ! ✓", "success");
        } else {
          setMsg("verifyMsg", "Email pas encore vérifié. Cliquez sur le lien dans votre email.");
        }
      } catch (e) {
        setMsg("verifyMsg", "Erreur de vérification.");
      }
    });

    // Resend verification
    $("#btnResendVerif")?.addEventListener("click", async () => {
      try {
        if (cloud.auth.currentUser) await sendEmailVerification(cloud.auth.currentUser);
        setMsg("verifyMsg", "Email renvoyé !", true);
      } catch {
        setMsg("verifyMsg", "Impossible de renvoyer l'email.");
      }
    });

    // Back to login from verify
    $("#btnBackLogin")?.addEventListener("click", async () => {
      if (cloud.auth.currentUser) await signOut(cloud.auth);
      showAuthForm("loginForm");
    });

    // Forgot password
    $("#btnForgot")?.addEventListener("click", async () => {
      setMsg("forgotMsg", "");
      const email = $("#forgot_email").value.trim();
      if (!email) { setMsg("forgotMsg", "Email requis."); return; }
      try {
        await sendPasswordResetEmail(cloud.auth, email);
        setMsg("forgotMsg", "Email envoyé ! Vérifiez votre boîte.", true);
      } catch (e) {
        setMsg("forgotMsg", friendlyAuthError(e.code));
      }
    });

    // Logout
    $("#btnLogout")?.addEventListener("click", async () => {
      if (!confirm("Se déconnecter ?")) return;
      await signOut(cloud.auth);
    });

    // ── Auth state change ─────────────────────────────────
    onAuthStateChanged(cloud.auth, async (user) => {
      cloud.user = user || null;
      if (cloud.unsub) { cloud.unsub(); cloud.unsub = null; }

      if (!user) {
        showAuthOverlay();
        setCloudBadge("Déconnecté", "");
        return;
      }

      if (!user.emailVerified) {
        showAuthOverlay();
        $$(".auth-form").forEach(f => f.classList.remove("active"));
        $("#verifyForm")?.classList.add("active");
        $("#verifyEmailText").textContent = `Votre email (${user.email}) n'est pas encore vérifié.`;
        return;
      }

      // ── Authenticated & verified ─────────────────────
      hideAuthOverlay();
      setCloudBadge(`Synchronisé · ${user.email}`, "ok");

      // Update sidebar user info
      if (user.email) {
        $("#sideUserEmail").textContent = user.email;
        $("#sideUserAvatar").textContent = user.email[0].toUpperCase();
      }

      // Load data from Firestore
      const ref = doc(cloud.db, "users", user.uid, "app", "state");
      const snap = await getDoc(ref);

      if (snap.exists()) {
        cloud.applying = true;
        state = normalizeState(snap.data());
        cloud.applying = false;
        saveLocal();
        rerender();
        toast("Données synchronisées ✓", "success");
      } else {
        await cloudWrite(cloud.db, user.uid, serverTimestamp());
        toast("Espace initialisé ✓", "success");
      }

      // Real-time listener
      cloud.unsub = onSnapshot(ref, (snap) => {
        if (!snap.exists() || cloud.applying) return;
        const incoming = normalizeState(snap.data());
        if (JSON.stringify(incoming) === JSON.stringify(state)) return;
        cloud.applying = true;
        state = incoming;
        cloud.applying = false;
        saveLocal();
        rerender();
        toast("Synchronisation reçue ↺");
      });

      window.__cloudSave = async () => {
        if (!cloud.enabled || !cloud.user) return;
        try { await cloudWrite(cloud.db, cloud.user.uid, serverTimestamp()); }
        catch (e) { console.error("Cloud write error:", e); toast("Erreur cloud ⚠", "error"); }
      };
    });

  } catch (e) {
    console.error("Firebase init:", e);
    setCloudBadge("Erreur Firebase", "err");
  }
}

function friendlyAuthError(code) {
  const map = {
    "auth/user-not-found":      "Aucun compte avec cet email.",
    "auth/wrong-password":      "Mot de passe incorrect.",
    "auth/invalid-email":       "Email invalide.",
    "auth/email-already-in-use":"Cet email est déjà utilisé.",
    "auth/weak-password":       "Mot de passe trop faible (8 caractères min).",
    "auth/invalid-credential":  "Email ou mot de passe incorrect.",
    "auth/too-many-requests":   "Trop de tentatives. Réessayez plus tard.",
    "auth/network-request-failed": "Erreur réseau. Vérifiez votre connexion."
  };
  return map[code] || "Erreur d'authentification. Réessayez.";
}

function showAuthOverlay() { $("#authOverlay")?.classList.remove("hidden"); $("#app")?.classList.add("hidden"); }
function hideAuthOverlay() { $("#authOverlay")?.classList.add("hidden");    $("#app")?.classList.remove("hidden"); }

// ── Routing ────────────────────────────────────────────────
let activeChart = null;

function currentTab() {
  return $(".nav-item.active")?.dataset.tab || "dashboard";
}

function setTab(tab) {
  $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.tab === tab));
  const titles = {
    dashboard:  ["Tableau de bord",   "Vue d'ensemble de votre gestion locative"],
    bailleur:   ["Bailleur",          "Vos informations propriétaire"],
    locataires: ["Locataires",        `${state.tenants.length} locataire(s) enregistré(s)`],
    quittances: ["Quittances PDF",    "Générer et télécharger une quittance"],
    suivi:      ["Suivi paiements",   "Statut mensuel des paiements par logement"],
    historique: ["Historique",        `${state.receipts.length} quittance(s) archivée(s)`]
  };
  const [title, sub] = titles[tab] || ["—", ""];
  $("#pageTitle").textContent = title;
  $("#pageSub").textContent = sub;
  render(tab);
}

function rerender() { setTab(currentTab()); }

// ── PDF export ─────────────────────────────────────────────
async function exportPDF(filename) {
  if (!window.html2pdf) { alert("html2pdf.js non chargé."); return; }
  const host = $("#pdfTemplate");
  const node = host?.firstElementChild;
  if (!node) throw new Error("pdfTemplate vide");

  host.classList.remove("hidden");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;pointer-events:none;opacity:1;";

  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const opt = {
    margin: [6, 6, 6, 6],
    filename,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
  };

  try { await window.html2pdf().set(opt).from(node).save(); }
  finally { host.classList.add("hidden"); host.removeAttribute("style"); }
}

// ── Statement rows helper ──────────────────────────────────
function buildStatementRows({ tenantId, propertyId, targetYear, targetMonth, currentRow }) {
  const targetKey = ymKey(targetYear, targetMonth);
  const list = (state.receipts || [])
    .filter(r => r.tenantId === tenantId && r.propertyId === propertyId && ymKey(r.year, r.month) <= targetKey)
    .sort((a, b) => ymKey(b.year, b.month) - ymKey(a.year, a.month));

  const currentKey = currentRow ? ymKey(currentRow.year, currentRow.month) : null;
  const prev = currentKey == null ? list : list.filter(r => ymKey(r.year, r.month) !== currentKey);
  const picked = prev.slice(0, 4).map(r => ({
    year: r.year, month: r.month,
    due: r.rentHc + r.charges, paid: r.total
  }));
  if (currentRow) picked.push({
    year: currentRow.year, month: currentRow.month,
    due: currentRow.rentHc + currentRow.charges, paid: currentRow.total
  });
  return picked.sort((a, b) => ymKey(a.year, a.month) - ymKey(b.year, b.month)).slice(-5);
}

function renderStatementInPdf(rows) {
  const wrap = $("#pdfStatementWrap");
  const body = $("#pdfStatementBody");
  if (!wrap || !body) return;
  if (!rows?.length) { wrap.style.display = "none"; body.innerHTML = ""; return; }
  wrap.style.display = "";
  body.innerHTML = rows.map(r => {
    const diff = r.paid - r.due;
    const sign = diff >= 0 ? "+" : "−";
    return `<tr>
      <td>${escapeHtml(cap(monthLabel(r.year, r.month)))}</td>
      <td>${escapeHtml(euro(r.due))}</td>
      <td>${escapeHtml(euro(r.paid))}</td>
      <td>${sign}${escapeHtml(euro(Math.abs(diff)))}</td>
    </tr>`;
  }).join("");
}

// ── Fill PDF template ──────────────────────────────────────
function fillPdfTemplate(receipt, statementRows) {
  const L = state.landlord;
  const { tenantId, propertyId, year, month, period, reference,
          tenantName, tenantAddress, propertyAddress, propertyLabel,
          rentHc, charges, adjustments, total, paymentMethod, dateIssued } = receipt;

  $("#pdfPeriod").textContent = `Période : ${period}`;
  $("#pdfRef").textContent = reference;

  $("#pdfLandlordLines").textContent = [
    L.fullName || "—", L.address || "",
    L.email ? `Email : ${L.email}` : "",
    L.phone ? `Tél : ${L.phone}` : ""
  ].filter(Boolean).join("\n") || "—";

  $("#pdfTenantLines").textContent = [tenantName || "—", tenantAddress || ""].filter(Boolean).join("\n") || "—";
  $("#pdfProperty").textContent = propertyAddress || "—";
  $("#pdfPropertyLabel").textContent = propertyLabel ? `(${propertyLabel})` : "";

  const lines = [
    { label: "Loyer (hors charges)", amount: rentHc },
    { label: "Charges", amount: charges },
    ...(adjustments || []).filter(a => a.label && a.amount !== 0)
  ];

  $("#pdfLines").innerHTML = lines.map(l =>
    `<tr><td>${escapeHtml(l.label)}</td><td>${escapeHtml(euro(l.amount))}</td></tr>`
  ).join("");

  const rows = statementRows || buildStatementRows({
    tenantId, propertyId, targetYear: year, targetMonth: month,
    currentRow: { year, month, rentHc, charges, total }
  });
  renderStatementInPdf(rows);

  $("#pdfTotal").textContent = euro(total);
  $("#pdfTotalLine").textContent = `Total : ${euro(total)}`;

  const city = L.city || "—";
  const dateStr = dateIssued ? formatFRDate(dateIssued) : "—";
  $("#pdfFooterLeft").innerHTML =
    `Fait à ${escapeHtml(city)}, le ${escapeHtml(dateStr)}<br/>Paiement : ${escapeHtml(paymentMethod || "—")}<br/><span style="color:#94a3b8">Document généré automatiquement.</span>`;

  $("#pdfSignText").textContent = L.signatureName || L.fullName || "—";
}

// ═══════════════════════════════════════════════════════════
//  RENDER FUNCTIONS
// ═══════════════════════════════════════════════════════════

// ── Dashboard ──────────────────────────────────────────────
function renderDashboard() {
  const body = $("#mainBody");
  if (!body) return;

  const now   = new Date();
  const curY  = now.getFullYear();
  const curM  = now.getMonth();

  const totalThisYear = state.receipts
    .filter(r => r.year === curY)
    .reduce((s, r) => s + r.total, 0);

  const totalTenants  = state.tenants.length;
  const totalProps    = state.tenants.reduce((s, t) => s + (t.properties?.length || 0), 0);
  const totalReceipts = state.receipts.length;

  // Last 6 months revenue for chart
  const last6 = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(curY, curM - 5 + i, 1);
    const y = d.getFullYear(), m = d.getMonth();
    const total = state.receipts.filter(r => r.year === y && r.month === m).reduce((s, r) => s + r.total, 0);
    return { label: new Date(y, m, 1).toLocaleDateString("fr-FR", { month: "short" }), total, y, m };
  });

  // Payment statuses for current month
  const paymentItems = [];
  state.tenants.forEach(t => {
    (t.properties || []).forEach(p => {
      const receipt = state.receipts.find(r => r.tenantId === t.id && r.propertyId === p.id && r.year === curY && r.month === curM);
      const payment = state.payments.find(py => py.tenantId === t.id && py.propertyId === p.id && py.year === curY && py.month === curM);
      const status = receipt ? "paid" : (payment?.status || "pending");
      paymentItems.push({ tenant: t.fullName, prop: p.label, amount: p.rentHc + p.charges, status });
    });
  });

  const paidCount    = paymentItems.filter(p => p.status === "paid").length;
  const pendingCount = paymentItems.filter(p => p.status === "pending").length;
  const lateCount    = paymentItems.filter(p => p.status === "late").length;

  const statusLabel = { paid: "Payé", pending: "En attente", late: "En retard" };

  body.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Revenus ${curY}</div>
        <div class="stat-value gold">${euro(totalThisYear)}</div>
        <div class="stat-sub">${totalReceipts} quittance(s) émise(s)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Locataires</div>
        <div class="stat-value">${totalTenants}</div>
        <div class="stat-sub">${totalProps} logement(s)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Payé ce mois</div>
        <div class="stat-value green">${paidCount}</div>
        <div class="stat-sub">${pendingCount} en attente · ${lateCount} retard</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Loyer mensuel total</div>
        <div class="stat-value">${euro(state.tenants.reduce((s, t) => s + (t.properties || []).reduce((ps, p) => ps + p.rentHc + p.charges, 0), 0))}</div>
        <div class="stat-sub">Toutes charges comprises</div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Revenus — 6 derniers mois</span>
          <span class="card-badge">loyer + charges</span>
        </div>
        <div class="card-body">
          <div class="chart-wrap">
            <canvas id="revenueChart"></canvas>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Paiements — ${cap(monthLabel(curY, curM))}</span>
          <span class="card-badge">${paidCount}/${paymentItems.length}</span>
        </div>
        <div class="card-body">
          ${paymentItems.length ? `
            <div class="payments-list">
              ${paymentItems.map(p => `
                <div class="payment-row">
                  <div class="payment-dot ${p.status}"></div>
                  <div class="payment-info">
                    <div class="payment-name">${escapeHtml(p.tenant)}</div>
                    <div class="payment-date">${escapeHtml(p.prop)}</div>
                  </div>
                  <div>
                    <div class="payment-amount">${euro(p.amount)}</div>
                    <div class="badge ${p.status === "paid" ? "ok" : p.status === "late" ? "warn" : "amber"}" style="margin-top:4px;font-size:10px">${statusLabel[p.status] || p.status}</div>
                  </div>
                </div>
              `).join("")}
            </div>
          ` : `<div class="empty-state">
            <div class="empty-icon">🏠</div>
            <div class="empty-title">Aucun locataire</div>
            <div class="empty-sub">Ajoutez vos locataires pour suivre les paiements.</div>
          </div>`}
        </div>
      </div>
    </div>

    ${hasLegacyData() ? `
      <div class="legacy-banner" style="margin-top:20px">
        <div class="legacy-banner-icon">📦</div>
        <div class="legacy-banner-text">
          <strong>Données d'ancienne version détectées.</strong><br/>
          Vos données ont été migrées automatiquement. Vérifiez vos locataires et quittances.
        </div>
        <button class="btn" id="btnDismissLegacy">Compris</button>
      </div>
    ` : ""}
  `;

  // Chart
  setTimeout(() => {
    const canvas = $("#revenueChart");
    if (!canvas || !window.Chart) return;
    if (activeChart) { activeChart.destroy(); activeChart = null; }
    activeChart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: last6.map(d => d.label),
        datasets: [{
          label: "Revenus (€)",
          data: last6.map(d => d.total),
          backgroundColor: "rgba(212,168,83,.25)",
          borderColor: "rgba(212,168,83,.8)",
          borderWidth: 2,
          borderRadius: 8,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: {
          callbacks: { label: ctx => ` ${euro(ctx.raw)}` }
        }},
        scales: {
          x: { grid: { color: "rgba(255,255,255,.04)" }, ticks: { color: "#6b6880", font: { family: "DM Sans" } } },
          y: { grid: { color: "rgba(255,255,255,.04)" }, ticks: { color: "#6b6880", callback: v => euro(v), font: { family: "DM Sans" } }, beginAtZero: true }
        }
      }
    });
  }, 100);

  $("#btnDismissLegacy")?.addEventListener("click", () => {
    localStorage.removeItem(LEGACY_KEY);
    rerender();
  });
}

function hasLegacyData() {
  return !!localStorage.getItem(LEGACY_KEY);
}

// ── Bailleur ───────────────────────────────────────────────
function renderBailleur() {
  const L = state.landlord;
  $("#mainBody").innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Informations bailleur</span>
        <span class="card-badge">signature auto</span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <div class="form-group">
            <label>Nom / Prénom ou raison sociale</label>
            <input id="l_fullName" value="${escapeHtml(L.fullName)}" placeholder="Jean Dupont">
          </div>
          <div class="form-group">
            <label>Ville (pour "Fait à …")</label>
            <input id="l_city" value="${escapeHtml(L.city)}" placeholder="Paris">
          </div>
          <div class="form-group">
            <label>Email</label>
            <input id="l_email" type="email" value="${escapeHtml(L.email)}" placeholder="jean@exemple.fr">
          </div>
          <div class="form-group">
            <label>Téléphone</label>
            <input id="l_phone" value="${escapeHtml(L.phone)}" placeholder="06…">
          </div>
          <div class="form-group full">
            <label>Adresse bailleur</label>
            <textarea id="l_address" placeholder="Adresse complète">${escapeHtml(L.address)}</textarea>
          </div>
          <div class="form-group">
            <label>Nom pour la signature (optionnel)</label>
            <input id="l_signatureName" value="${escapeHtml(L.signatureName)}" placeholder="Par défaut : Nom / Prénom">
          </div>
          <div class="form-group">
            <label>Aperçu signature</label>
            <div style="padding:12px;background:var(--ink-mid);border:1px solid var(--border-md);border-radius:var(--radius-sm);min-height:52px;display:flex;align-items:center">
              <span id="signPreview" style="font-family:'Playfair Display',Georgia,serif;font-size:30px;font-style:italic;color:var(--gold)">
                ${escapeHtml(L.signatureName || L.fullName || "—")}
              </span>
            </div>
          </div>
        </div>
        <div class="btn-group">
          <button class="btn primary" id="btnSaveLandlord">Enregistrer</button>
        </div>
      </div>
    </div>
  `;

  // Live signature preview
  const updateSig = () => {
    const v = $("#l_signatureName").value.trim() || $("#l_fullName").value.trim() || "—";
    $("#signPreview").textContent = v;
  };
  $("#l_fullName").addEventListener("input", updateSig);
  $("#l_signatureName").addEventListener("input", updateSig);

  $("#btnSaveLandlord").addEventListener("click", async () => {
    state.landlord.fullName      = $("#l_fullName").value.trim();
    state.landlord.city          = $("#l_city").value.trim();
    state.landlord.email         = $("#l_email").value.trim();
    state.landlord.phone         = $("#l_phone").value.trim();
    state.landlord.address       = $("#l_address").value.trim();
    state.landlord.signatureName = $("#l_signatureName").value.trim();
    await saveState();
    toast("Bailleur enregistré ✓", "success");
    renderBailleur();
  });
}

// ── Locataires ─────────────────────────────────────────────
function renderLocataires() {
  const body = $("#mainBody");

  const listHtml = state.tenants.length ? `
    <div class="list" style="margin-bottom:20px">
      ${state.tenants.map(t => `
        <div class="list-item">
          <div class="list-item-meta">
            <div class="list-item-name">${escapeHtml(t.fullName || "Sans nom")}</div>
            <div class="list-item-sub">
              ${(t.properties || []).map(p =>
                `<span style="margin-right:10px">🏠 ${escapeHtml(p.label)} · ${euro(p.rentHc + p.charges)}</span>`
              ).join("")}
            </div>
          </div>
          <div class="list-item-actions">
            <span class="badge">${t.paymentMethod}</span>
            <button class="btn" data-edit="${t.id}">Modifier</button>
            <button class="btn danger" data-del="${t.id}">Supprimer</button>
          </div>
        </div>
      `).join("")}
    </div>
  ` : `<div class="note" style="margin-bottom:20px">Aucun locataire. Créez le premier ci-dessous.</div>`;

  body.innerHTML = `
    ${listHtml}
    <div class="card">
      <div class="card-header">
        <span class="card-title" id="tenantFormTitle">Ajouter un locataire</span>
        <span class="card-badge">multi-logements</span>
      </div>
      <div class="card-body" id="tenantFormBody"></div>
    </div>
  `;

  renderTenantForm(null);

  $$("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = state.tenants.find(x => x.id === btn.dataset.edit);
      if (!t) return;
      $("#tenantFormTitle").textContent = "Modifier le locataire";
      renderTenantForm(t);
    });
  });

  $$("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const t = state.tenants.find(x => x.id === btn.dataset.del);
      if (!confirm(`Supprimer ${t?.fullName || "ce locataire"} ?`)) return;
      state.tenants  = state.tenants.filter(x => x.id !== btn.dataset.del);
      state.receipts = state.receipts.filter(r => r.tenantId !== btn.dataset.del);
      state.payments = state.payments.filter(p => p.tenantId !== btn.dataset.del);
      await saveState();
      toast("Locataire supprimé", "");
      renderLocataires();
    });
  });
}

function renderTenantForm(tenant) {
  const isEdit = !!tenant;
  const t = tenant ? structuredClone(tenant) : {
    id: uid(), fullName: "", tenantAddress: "", paymentMethod: "Virement",
    properties: [{ id: uid(), label: "Logement 1", address: "", rentHc: 0, charges: 0 }]
  };

  const body = $("#tenantFormBody");
  body.innerHTML = `
    <div class="form-grid">
      <div class="form-group">
        <label>Nom du locataire</label>
        <input id="t_fullName" value="${escapeHtml(t.fullName)}" placeholder="Marie Martin">
      </div>
      <div class="form-group">
        <label>Moyen de paiement</label>
        <select id="t_paymentMethod">
          ${["Virement", "Chèque", "Espèces", "Prélèvement", "Autre"].map(v =>
            `<option value="${v}" ${t.paymentMethod === v ? "selected" : ""}>${v}</option>`
          ).join("")}
        </select>
      </div>
      <div class="form-group full">
        <label>Adresse du locataire (optionnel)</label>
        <textarea id="t_tenantAddress" placeholder="Adresse">${escapeHtml(t.tenantAddress)}</textarea>
      </div>
    </div>

    <div class="divider"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <span style="font-weight:600;font-size:14px">Logements</span>
      <button class="btn" id="btnAddProp">+ Ajouter un logement</button>
    </div>
    <div id="propsList"></div>
    <div class="mini">Les montants sont modifiables lors de la génération de chaque quittance.</div>

    <div class="btn-group">
      <button class="btn primary" id="btnSaveTenant">${isEdit ? "Enregistrer" : "Ajouter"}</button>
      ${isEdit ? `<button class="btn" id="btnCancelEdit">Annuler</button>` : ""}
    </div>
  `;

  function renderProps() {
    $("#propsList").innerHTML = t.properties.map(p => `
      <div class="prop-chip">
        <div class="prop-chip-icon">🏠</div>
        <div class="prop-chip-info" style="flex:1">
          <div class="form-grid" style="margin:0;gap:10px">
            <div class="form-group">
              <label>Libellé</label>
              <input data-p="${p.id}" data-k="label" value="${escapeHtml(p.label)}" placeholder="Studio Rue X">
            </div>
            <div class="form-group">
              <label>Loyer HC (€)</label>
              <input data-p="${p.id}" data-k="rentHc" type="number" step="0.01" min="0" value="${p.rentHc}">
            </div>
            <div class="form-group full">
              <label>Adresse du logement</label>
              <textarea data-p="${p.id}" data-k="address" placeholder="Adresse complète" style="min-height:60px">${escapeHtml(p.address)}</textarea>
            </div>
            <div class="form-group">
              <label>Charges (€)</label>
              <input data-p="${p.id}" data-k="charges" type="number" step="0.01" value="${p.charges}">
              <div class="mini">Total : <strong style="color:var(--gold)">${euro(p.rentHc + p.charges)}</strong></div>
            </div>
          </div>
        </div>
        <button class="btn danger" data-delprop="${p.id}" ${t.properties.length <= 1 ? "disabled" : ""} style="align-self:flex-start;margin-top:20px">✕</button>
      </div>
    `).join("");

    $$("[data-p][data-k]", $("#propsList")).forEach(el => {
      el.addEventListener("input", () => {
        const prop = t.properties.find(x => x.id === el.dataset.p);
        if (!prop) return;
        const k = el.dataset.k;
        prop[k] = (k === "rentHc" || k === "charges") ? Number(el.value || 0) : el.value;
      });
    });

    $$("[data-delprop]", $("#propsList")).forEach(btn => {
      btn.addEventListener("click", () => {
        if (t.properties.length <= 1) return;
        t.properties = t.properties.filter(x => x.id !== btn.dataset.delprop);
        renderProps();
      });
    });
  }

  renderProps();

  $("#btnAddProp").addEventListener("click", () => {
    t.properties.push({ id: uid(), label: `Logement ${t.properties.length + 1}`, address: "", rentHc: 0, charges: 0 });
    renderProps();
  });

  $("#btnSaveTenant").addEventListener("click", async () => {
    t.fullName       = $("#t_fullName").value.trim();
    t.paymentMethod  = $("#t_paymentMethod").value;
    t.tenantAddress  = $("#t_tenantAddress").value.trim();

    if (!t.fullName) { toast("Nom du locataire requis.", "error"); return; }
    if (t.properties.some(p => !p.address.trim())) { toast("Chaque logement doit avoir une adresse.", "error"); return; }

    if (isEdit) {
      const idx = state.tenants.findIndex(x => x.id === t.id);
      if (idx >= 0) state.tenants[idx] = t;
    } else {
      state.tenants.unshift(t);
    }

    await saveState();
    toast(isEdit ? "Locataire mis à jour ✓" : "Locataire ajouté ✓", "success");
    renderLocataires();
  });

  $("#btnCancelEdit")?.addEventListener("click", renderLocataires);
}

// ── Quittances ─────────────────────────────────────────────
function renderQuittances() {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();

  $("#mainBody").innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title">Nouvelle quittance</span>
        <span class="card-badge">montants modifiables</span>
      </div>
      <div class="card-body">

        <div class="form-grid">
          <div class="form-group">
            <label>Locataire</label>
            <select id="r_tenantId">
              ${state.tenants.length
                ? state.tenants.map(t => `<option value="${t.id}">${escapeHtml(t.fullName)}</option>`).join("")
                : `<option value="">Aucun locataire</option>`}
            </select>
          </div>
          <div class="form-group">
            <label>Logement</label>
            <select id="r_propertyId"></select>
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label>Période</label>
            <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:10px">
              <select id="r_month">
                ${Array.from({ length: 12 }, (_, i) => {
                  const mn = new Date(2000, i, 1).toLocaleDateString("fr-FR", { month: "long" });
                  return `<option value="${i}" ${i === m ? "selected" : ""}>${mn}</option>`;
                }).join("")}
              </select>
              <input id="r_year" type="number" min="2000" max="2100" value="${y}">
            </div>
          </div>
          <div class="form-group">
            <label>Date d'édition</label>
            <input id="r_date" type="date" value="${toISODate(today)}">
          </div>
        </div>

        <div class="form-grid">
          <div class="form-group">
            <label>Référence (optionnel)</label>
            <input id="r_ref" placeholder="Q-${y}-${String(m + 1).padStart(2, "0")}-001">
          </div>
          <div class="form-group">
            <label>Total (aperçu)</label>
            <input id="r_totalPreview" disabled style="font-family:var(--font-mono);color:var(--gold)">
          </div>
        </div>

        <div class="divider"></div>

        <div class="form-grid">
          <div class="form-group">
            <label>Loyer hors charges (€)</label>
            <input id="r_rent" type="number" step="0.01" min="0" value="0">
          </div>
          <div class="form-group">
            <label>Charges (€)</label>
            <input id="r_charges" type="number" step="0.01" value="0">
          </div>
        </div>

        <label style="margin-bottom:10px;display:block">Lignes supplémentaires</label>
        <div id="adjList" style="margin-bottom:10px"></div>
        <div class="btn-group" style="margin-top:0">
          <button class="btn" id="btnAddAdj">+ Ligne libre</button>
          <button class="btn" id="btnQuickReg">+ Régularisation charges</button>
          <button class="btn" id="btnQuickDiscount">+ Remise</button>
        </div>
        <div class="mini">Montants négatifs = remise / avoir.</div>

        <div class="divider"></div>

        <div class="btn-group">
          <button class="btn primary" id="btnGenerate" ${state.tenants.length ? "" : "disabled"}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Générer le PDF
          </button>
        </div>
        <div class="note" style="margin-top:14px">💡 Une quittance atteste un paiement — à générer après encaissement.</div>
      </div>
    </div>
  `;

  const draft = { adjustments: [] };
  const tenantSel = $("#r_tenantId");
  const propSel   = $("#r_propertyId");

  const getTenant = () => state.tenants.find(t => t.id === tenantSel.value);
  const getProp   = () => getTenant()?.properties?.find(p => p.id === propSel.value);

  function updatePropOptions() {
    const t = getTenant();
    propSel.innerHTML = (t?.properties || []).map(p =>
      `<option value="${p.id}">${escapeHtml(p.label)}</option>`
    ).join("");
    applyDefaults();
  }

  function applyDefaults() {
    const p = getProp();
    $("#r_rent").value    = String(p?.rentHc || 0);
    $("#r_charges").value = String(p?.charges || 0);
    computeTotal();
  }

  function computeTotal() {
    const rent    = Number($("#r_rent").value || 0);
    const charges = Number($("#r_charges").value || 0);
    const extra   = draft.adjustments.reduce((s, a) => s + Number(a.amount || 0), 0);
    const total   = rent + charges + extra;
    $("#r_totalPreview").value = euro(total);
    return { rent, charges, total };
  }

  function renderAdjs() {
    const box = $("#adjList");
    if (!draft.adjustments.length) { box.innerHTML = ""; return; }
    box.innerHTML = draft.adjustments.map((a, i) => `
      <div style="display:grid;grid-template-columns:1.6fr .6fr auto;gap:10px;align-items:end;margin-bottom:10px">
        <div class="form-group" style="margin:0">
          <label>Libellé</label>
          <input data-ai="${i}" data-k="label" value="${escapeHtml(a.label)}" placeholder="Ex : Régularisation">
        </div>
        <div class="form-group" style="margin:0">
          <label>Montant €</label>
          <input data-ai="${i}" data-k="amount" type="number" step="0.01" value="${a.amount}">
        </div>
        <button class="btn danger" data-delai="${i}">✕</button>
      </div>
    `).join("");

    $$("[data-ai][data-k]", box).forEach(el => {
      el.addEventListener("input", () => {
        const i = Number(el.dataset.ai);
        const k = el.dataset.k;
        if (!draft.adjustments[i]) return;
        draft.adjustments[i][k] = k === "amount" ? Number(el.value || 0) : el.value;
        computeTotal();
      });
    });

    $$("[data-delai]", box).forEach(btn => {
      btn.addEventListener("click", () => {
        draft.adjustments.splice(Number(btn.dataset.delai), 1);
        renderAdjs(); computeTotal();
      });
    });
  }

  if (state.tenants.length) {
    tenantSel.value = state.tenants[0].id;
    updatePropOptions();
  }
  computeTotal();

  tenantSel.addEventListener("change", updatePropOptions);
  propSel.addEventListener("change", applyDefaults);
  $("#r_rent").addEventListener("input", computeTotal);
  $("#r_charges").addEventListener("input", computeTotal);

  $("#btnAddAdj").addEventListener("click",       () => { draft.adjustments.push({ label: "Autre", amount: 0 }); renderAdjs(); computeTotal(); });
  $("#btnQuickReg").addEventListener("click",     () => { draft.adjustments.push({ label: "Régularisation de charges", amount: 0 }); renderAdjs(); computeTotal(); });
  $("#btnQuickDiscount").addEventListener("click",() => { draft.adjustments.push({ label: "Remise exceptionnelle", amount: 0 }); renderAdjs(); computeTotal(); });

  $("#btnGenerate")?.addEventListener("click", async () => {
    const tenant = getTenant();
    const prop   = getProp();
    if (!tenant || !prop) return;

    if (document.fonts?.ready) await document.fonts.ready.catch(() => {});

    const monthIndex = Number($("#r_month").value);
    const year       = Number($("#r_year").value);
    const dateStr    = $("#r_date").value;
    const periodLbl  = cap(monthLabel(year, monthIndex));
    const ref = ($("#r_ref").value || "").trim()
      || `Q-${year}-${String(monthIndex + 1).padStart(2, "0")}-${tenant.fullName.replace(/\s+/g, "_")}`;

    const rent    = Number($("#r_rent").value || 0);
    const charges = Number($("#r_charges").value || 0);
    const adjs    = normalizeAdjustments(draft.adjustments).filter(a => a.amount !== 0);
    const total   = rent + charges + adjs.reduce((s, a) => s + a.amount, 0);

    const receipt = {
      id: uid(), tenantId: tenant.id, tenantName: tenant.fullName,
      tenantAddress: tenant.tenantAddress || "",
      propertyId: prop.id, propertyLabel: prop.label, propertyAddress: prop.address,
      year, month: monthIndex, period: periodLbl, reference: ref, dateIssued: dateStr,
      rentHc: rent, charges, adjustments: adjs, total,
      paymentMethod: tenant.paymentMethod, createdAt: Date.now()
    };

    fillPdfTemplate(receipt, null);

    try {
      const filename = safeFileName(`Quittance_${tenant.fullName}_${periodLbl}.pdf`);
      await exportPDF(filename);
      state.receipts.unshift(receipt);

      // Auto-mark as paid in payment tracker
      const existingPayment = state.payments.find(p =>
        p.tenantId === tenant.id && p.propertyId === prop.id && p.year === year && p.month === monthIndex
      );
      if (!existingPayment) {
        state.payments.push({ id: uid(), tenantId: tenant.id, propertyId: prop.id,
          year, month: monthIndex, status: "paid", note: "", updatedAt: Date.now() });
      } else {
        existingPayment.status = "paid";
        existingPayment.updatedAt = Date.now();
      }

      await saveState();
      toast("PDF généré et enregistré ✓", "success");
    } catch (e) {
      console.error(e);
      toast("Erreur génération PDF", "error");
    }
  });
}

// ── Suivi paiements ────────────────────────────────────────
function renderSuivi() {
  const now  = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth();

  // Month selector
  const monthsSel = Array.from({ length: 12 }, (_, i) => ({
    y: i <= curM ? curY : curY - 1,
    m: i <= curM ? curM - i : curM + 12 - i
  })).reverse().slice(-6);

  const selY = Number($("#suiviYear")?.value ?? curY) || curY;
  const selM = Number($("#suiviMonth")?.value ?? curM);

  const allItems = [];
  state.tenants.forEach(t => {
    (t.properties || []).forEach(p => {
      const hasReceipt = state.receipts.some(r =>
        r.tenantId === t.id && r.propertyId === p.id && r.year === selY && r.month === selM
      );
      const payment = state.payments.find(py =>
        py.tenantId === t.id && py.propertyId === p.id && py.year === selY && py.month === selM
      );
      const status = hasReceipt ? "paid" : (payment?.status || "pending");
      allItems.push({ tenant: t, prop: p, status, payment, hasReceipt });
    });
  });

  const statusLabel = { paid: "Payé ✓", pending: "En attente", late: "En retard ⚠" };

  $("#mainBody").innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;flex-wrap:wrap">
      <select id="suiviMonth" style="width:160px">
        ${Array.from({ length: 12 }, (_, i) => {
          const mn = new Date(2000, i, 1).toLocaleDateString("fr-FR", { month: "long" });
          return `<option value="${i}" ${i === selM ? "selected" : ""}>${mn}</option>`;
        }).join("")}
      </select>
      <input id="suiviYear" type="number" min="2020" max="2099" value="${selY}" style="width:100px">
      <div class="badge ok">${allItems.filter(x => x.status === "paid").length} payés</div>
      <div class="badge amber">${allItems.filter(x => x.status === "pending").length} en attente</div>
      <div class="badge warn">${allItems.filter(x => x.status === "late").length} en retard</div>
    </div>

    ${allItems.length ? `
      <div class="suivi-grid" id="suiviGrid">
        ${allItems.map(({ tenant, prop, status, hasReceipt }) => `
          <div class="suivi-card">
            <div class="suivi-tenant">${escapeHtml(tenant.fullName)}</div>
            <div class="suivi-prop">🏠 ${escapeHtml(prop.label)} · ${escapeHtml(prop.address.split("\n")[0])}</div>
            <div class="suivi-amount">${euro(prop.rentHc + prop.charges)}</div>
            <div class="suivi-sub">Loyer HC ${euro(prop.rentHc)} + Charges ${euro(prop.charges)}</div>
            <div class="suivi-status">
              <span class="status-pill ${status}">
                ${statusLabel[status] || status}
              </span>
              ${hasReceipt ? `<span class="badge gold" style="font-size:10px">Quittance émise</span>` : ""}
              <div style="flex:1"></div>
              ${!hasReceipt ? `
                <select class="status-select" data-tid="${tenant.id}" data-pid="${prop.id}" data-y="${selY}" data-m="${selM}" style="max-width:130px;padding:6px 10px;font-size:12px">
                  <option value="pending" ${status === "pending" ? "selected" : ""}>En attente</option>
                  <option value="paid"    ${status === "paid"    ? "selected" : ""}>Payé</option>
                  <option value="late"    ${status === "late"    ? "selected" : ""}>En retard</option>
                </select>
              ` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    ` : `
      <div class="empty-state">
        <div class="empty-icon">🏠</div>
        <div class="empty-title">Aucun locataire</div>
        <div class="empty-sub">Ajoutez des locataires pour suivre les paiements.</div>
      </div>
    `}
  `;

  const reloadSuivi = () => renderSuivi();
  $("#suiviMonth").addEventListener("change", reloadSuivi);
  $("#suiviYear").addEventListener("change",  reloadSuivi);

  $$(".status-select").forEach(sel => {
    sel.addEventListener("change", async () => {
      const { tid, pid, y, m } = sel.dataset;
      const existing = state.payments.find(p =>
        p.tenantId === tid && p.propertyId === pid && p.year === Number(y) && p.month === Number(m)
      );
      if (existing) {
        existing.status = sel.value;
        existing.updatedAt = Date.now();
      } else {
        state.payments.push({ id: uid(), tenantId: tid, propertyId: pid,
          year: Number(y), month: Number(m), status: sel.value, note: "", updatedAt: Date.now() });
      }
      await saveState();
      toast("Statut mis à jour ✓", "success");
    });
  });
}

// ── Historique ─────────────────────────────────────────────
function renderHistorique() {
  const receipts = [...state.receipts].sort((a, b) => b.createdAt - a.createdAt);
  const curY     = new Date().getFullYear();
  const totalY   = receipts.filter(r => r.year === curY).reduce((s, r) => s + r.total, 0);

  if (!receipts.length) {
    $("#mainBody").innerHTML = `<div class="note">Aucune quittance. Générez votre première depuis l'onglet "Quittances PDF".</div>`;
    return;
  }

  const byYear = receipts.reduce((acc, r) => {
    (acc[r.year] = acc[r.year] || []).push(r);
    return acc;
  }, {});

  $("#mainBody").innerHTML = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">
      <div class="badge ok" style="padding:12px 18px;font-size:13px">
        <span>Revenus ${curY}</span>
        <span style="font-size:17px;margin-left:10px;font-family:var(--font-mono)">${euro(totalY)}</span>
      </div>
      <div class="badge" style="padding:12px 18px;font-size:13px">
        <span>Total quittances</span>
        <span style="font-size:17px;margin-left:10px;font-family:var(--font-mono)">${receipts.length}</span>
      </div>
    </div>

    ${Object.keys(byYear).sort((a, b) => b - a).map(year => {
      const list  = byYear[year];
      const total = list.reduce((s, r) => s + r.total, 0);
      return `
        <div class="year-section">
          <div class="year-header">
            <span class="year-title">${year}</span>
            <span class="badge ok">${list.length} quittances · ${euro(total)}</span>
          </div>
          ${list.map(r => `
            <div class="receipt-row">
              <div>
                <div class="receipt-tenant">${escapeHtml(r.tenantName)}</div>
                <div class="receipt-meta">📅 ${escapeHtml(r.period)} · 🏠 ${escapeHtml(r.propertyLabel || r.propertyAddress)} · Réf: ${escapeHtml(r.reference)}</div>
              </div>
              <div class="receipt-amount">${euro(r.total)}</div>
              <div class="receipt-actions">
                <button class="btn" data-view="${r.id}" title="Détails">👁</button>
                <button class="btn" data-regen="${r.id}" title="Télécharger">⬇</button>
                <button class="btn danger" data-delrec="${r.id}" title="Supprimer">✕</button>
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }).join("")}
  `;

  $$("[data-view]").forEach(btn => {
    btn.addEventListener("click", () => {
      const r = state.receipts.find(x => x.id === btn.dataset.view);
      if (r) showReceiptModal(r);
    });
  });

  $$("[data-regen]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const r = state.receipts.find(x => x.id === btn.dataset.regen);
      if (!r) return;
      if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
      fillPdfTemplate(r, null);
      try {
        await exportPDF(safeFileName(`Quittance_${r.tenantName}_${r.period}.pdf`));
        toast("PDF téléchargé ✓", "success");
      } catch (e) { toast("Erreur PDF", "error"); }
    });
  });

  $$("[data-delrec]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const r = state.receipts.find(x => x.id === btn.dataset.delrec);
      if (!r || !confirm(`Supprimer la quittance :\n${r.tenantName} · ${r.period} · ${euro(r.total)}`)) return;
      state.receipts = state.receipts.filter(x => x.id !== r.id);
      await saveState();
      toast("Quittance supprimée");
      renderHistorique();
    });
  });
}

function showReceiptModal(receipt) {
  const allLines = [
    { label: "Loyer (hors charges)", amount: receipt.rentHc },
    { label: "Charges", amount: receipt.charges },
    ...(receipt.adjustments || [])
  ];

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h2 class="modal-title">${escapeHtml(receipt.tenantName)}</h2>
        <button class="modal-close" id="modalClose">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap">
        <span class="badge">${escapeHtml(receipt.period)}</span>
        <span class="badge gold">${euro(receipt.total)}</span>
        <span class="badge info">Réf: ${escapeHtml(receipt.reference)}</span>
      </div>

      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin-bottom:14px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3);margin-bottom:10px">Logement</div>
        <div style="font-weight:600">${escapeHtml(receipt.propertyLabel || "")}</div>
        <div style="color:var(--text-2);font-size:13px;margin-top:4px">${escapeHtml(receipt.propertyAddress)}</div>
      </div>

      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px;margin-bottom:14px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3);margin-bottom:10px">Détail</div>
        ${allLines.map(l => `
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
            <span style="color:var(--text-2)">${escapeHtml(l.label)}</span>
            <span style="font-family:var(--font-mono);font-weight:600">${euro(l.amount)}</span>
          </div>
        `).join("")}
        <div style="display:flex;justify-content:space-between;padding:14px 0 4px;font-size:17px;font-weight:700">
          <span>Total</span>
          <span style="color:var(--gold);font-family:var(--font-mono)">${euro(receipt.total)}</span>
        </div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--text-2);margin-bottom:20px">
        <span>📅 Émis le ${formatFRDate(receipt.dateIssued)}</span>
        <span>·</span>
        <span>💳 ${escapeHtml(receipt.paymentMethod)}</span>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn primary" id="modalDownload">⬇ Télécharger PDF</button>
        <button class="btn" id="modalClose2">Fermer</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.addEventListener("click", e => { if (e.target === backdrop) close(); });
  $("#modalClose", backdrop).addEventListener("click", close);
  $("#modalClose2", backdrop).addEventListener("click", close);

  $("#modalDownload", backdrop).addEventListener("click", async () => {
    if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
    fillPdfTemplate(receipt, null);
    try {
      await exportPDF(safeFileName(`Quittance_${receipt.tenantName}_${receipt.period}.pdf`));
      toast("PDF téléchargé ✓", "success");
      close();
    } catch { toast("Erreur PDF", "error"); }
  });
}

// ── Router ─────────────────────────────────────────────────
function render(tab) {
  if (activeChart && tab !== "dashboard") { activeChart.destroy(); activeChart = null; }
  switch (tab) {
    case "dashboard":  return renderDashboard();
    case "bailleur":   return renderBailleur();
    case "locataires": return renderLocataires();
    case "quittances": return renderQuittances();
    case "suivi":      return renderSuivi();
    case "historique": return renderHistorique();
  }
}

// ── Export / Import ─────────────────────────────────────────
function initToolbar() {
  $("#btnExport")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), { href: url, download: "locataire_pro_data.json" });
    a.click(); URL.revokeObjectURL(url);
    toast("Données exportées ✓", "success");
  });

  $("#btnImportTrigger")?.addEventListener("click", () => $("#fileImport")?.click());

  $("#fileImport")?.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      state = normalizeState(JSON.parse(text));
      await saveState();
      rerender();
      toast("Import réussi ✓", "success");
    } catch { toast("Fichier invalide", "error"); }
    finally { e.target.value = ""; }
  });

  // Nav items
  $$(".nav-item").forEach(n => {
    n.addEventListener("click", () => setTab(n.dataset.tab));
  });
}

// ── Bootstrap ──────────────────────────────────────────────
async function start() {
  initToolbar();

  // If no Firebase config, open app immediately (offline mode)
  const hasFB = FB_CFG?.apiKey && !FB_CFG.apiKey.includes("...");
  if (!hasFB) {
    hideAuthOverlay();
    setCloudBadge("Mode hors ligne", "");
    setTab("dashboard");
  }

  await initFirebase();

  if (!hasFB) {
    setTab("dashboard");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
