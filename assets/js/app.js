/* app.js - module */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function uid() {
  return (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : ("id_" + Math.random().toString(16).slice(2) + "_" + Date.now());
}

function euro(n) {
  return Number(n || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
}

function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = "";
  }, 3500);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toISODate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatFRDate(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
}

function monthLabel(year, mi) {
  return new Date(year, mi, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function safeFileName(name) {
  return String(name || "document")
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll(":", "-")
    .replaceAll("*", "")
    .replaceAll("?", "")
    .replaceAll('"', "'")
    .replaceAll("<", "(")
    .replaceAll(">", ")")
    .replaceAll("|", "-")
    .replace(/\s+/g, "_")
    .slice(0, 180);
}

function normalizeAdjustments(adjs) {
  const arr = Array.isArray(adjs) ? adjs : [];
  return arr
    .map(a => ({
      label: String(a?.label ?? "").trim(),
      amount: Number(a?.amount ?? 0)
    }))
    .filter(a => a.label); // on garde seulement ceux avec un libellé
}

// --------------------
// State (local + cloud)
// --------------------
const STORAGE_KEY = "quittances_state_v3";

const defaultState = {
  landlord: { fullName: "", address: "", email: "", phone: "", city: "", signatureName: "" },
  tenants: [],
  receipts: []
};

function normalizeState(data) {
  const landlord = { ...defaultState.landlord, ...(data?.landlord || {}) };

  const tenantsRaw = Array.isArray(data?.tenants) ? data.tenants : [];
  const tenants = tenantsRaw.map(t => {
    const tenant = { ...t };
    tenant.id = tenant.id || uid();
    tenant.fullName = tenant.fullName || "";
    tenant.tenantAddress = tenant.tenantAddress || "";
    tenant.paymentMethod = tenant.paymentMethod || "Virement";

    if (!Array.isArray(tenant.properties)) {
      // migration legacy
      tenant.properties = [{
        id: uid(),
        label: "Logement 1",
        address: tenant.propertyAddress || "",
        rentHc: Number(tenant.rentHc || 0),
        charges: Number(tenant.charges || 0)
      }];
    }

    tenant.properties = tenant.properties.map(p => ({
      id: p.id || uid(),
      label: String(p.label || "Logement").trim() || "Logement",
      address: String(p.address || "").trim(),
      rentHc: Number(p.rentHc || 0),
      charges: Number(p.charges || 0)
    }));

    delete tenant.propertyAddress;
    delete tenant.rentHc;
    delete tenant.charges;

    return tenant;
  });

  const receipts = Array.isArray(data?.receipts)
    ? data.receipts.map(r => ({
      id: r.id || uid(),
      tenantId: r.tenantId || "",
      tenantName: r.tenantName || "",
      tenantAddress: r.tenantAddress || "",

      propertyId: r.propertyId || "",
      propertyLabel: r.propertyLabel || "",
      propertyAddress: r.propertyAddress || "",

      year: Number(r.year || new Date().getFullYear()),
      month: Number(r.month || 0),
      period: r.period || "",
      reference: r.reference || "",
      dateIssued: r.dateIssued || toISODate(new Date()),

      rentHc: Number(r.rentHc || 0),
      charges: Number(r.charges || 0),
      adjustments: normalizeAdjustments(r.adjustments),
      total: Number(r.total || 0),

      paymentMethod: r.paymentMethod || "Virement",
      createdAt: Number(r.createdAt || Date.now())
    }))
    : [];

  return { landlord, tenants, receipts };
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaultState);
    return normalizeState(JSON.parse(raw));
  } catch {
    return structuredClone(defaultState);
  }
}

function saveLocal() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ landlord: state.landlord, tenants: state.tenants, receipts: state.receipts })
  );
}

let state = loadLocal();

// --------------------
// Firebase (optional)
// --------------------
const FIREBASE_VERSION = "10.12.2";
const FIREBASE_CONFIG = window.FIREBASE_CONFIG || null;

let cloud = {
  enabled: false,
  auth: null,
  db: null,
  user: null,
  unsub: null,
  applying: false
};

function setCloudBadge(text, ok) {
  const el = $("#cloudStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "warn");
  el.classList.add(ok ? "ok" : "warn");
}

function setAuthMsg(msg) {
  const el = $("#authMsg");
  if (!el) return;
  el.textContent = msg || "";
}

async function initFirebase() {
  if (!FIREBASE_CONFIG || !FIREBASE_CONFIG.apiKey || String(FIREBASE_CONFIG.apiKey).includes("...")) {
    setCloudBadge("Cloud : non configuré", false);
    return;
  }

  try {
    const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`);
    const {
      getAuth,
      onAuthStateChanged,
      signInWithEmailAndPassword,
      createUserWithEmailAndPassword,
      signOut
    } = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`);
    const {
      getFirestore,
      doc,
      getDoc,
      setDoc,
      onSnapshot,
      serverTimestamp
    } = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`);

    const app = initializeApp(FIREBASE_CONFIG);
    cloud.auth = getAuth(app);
    cloud.db = getFirestore(app);
    cloud.enabled = true;

    $("#authBox")?.classList.remove("hidden");
    setCloudBadge("Cloud : prêt (connecte-toi)", true);

    $("#btnLogin")?.addEventListener("click", async () => {
      setAuthMsg("");
      try {
        await signInWithEmailAndPassword(cloud.auth, $("#auth_email").value.trim(), $("#auth_pass").value);
      } catch (e) {
        setAuthMsg(e?.message || "Erreur connexion");
      }
    });

    $("#btnRegister")?.addEventListener("click", async () => {
      setAuthMsg("");
      try {
        await createUserWithEmailAndPassword(cloud.auth, $("#auth_email").value.trim(), $("#auth_pass").value);
      } catch (e) {
        setAuthMsg(e?.message || "Erreur inscription");
      }
    });

    $("#btnLogout")?.addEventListener("click", async () => {
      setAuthMsg("");
      try {
        await signOut(cloud.auth);
      } catch {
        setAuthMsg("Erreur déconnexion");
      }
    });

    async function cloudWrite() {
      const ref = doc(cloud.db, "users", cloud.user.uid, "app", "state");
      await setDoc(
        ref,
        { landlord: state.landlord, tenants: state.tenants, receipts: state.receipts, updatedAt: serverTimestamp() },
        { merge: true }
      );
    }

    onAuthStateChanged(cloud.auth, async (user) => {
      cloud.user = user || null;

      if (cloud.unsub) { cloud.unsub(); cloud.unsub = null; }

      if (!cloud.user) {
        $("#btnLogout")?.classList.add("hidden");
        setCloudBadge("Cloud : prêt (déconnecté)", true);
        setAuthMsg("Déconnecté. Les modifications restent locales.");
        return;
      }

      $("#btnLogout")?.classList.remove("hidden");
      setCloudBadge(`Cloud : connecté (${cloud.user.email || cloud.user.uid})`, true);
      setAuthMsg("Connecté. Synchronisation active.");

      const ref = doc(cloud.db, "users", cloud.user.uid, "app", "state");
      const snap = await getDoc(ref);

      if (snap.exists()) {
        cloud.applying = true;
        state = normalizeState(snap.data());
        cloud.applying = false;
        saveLocal();
        rerender();
        toast("Données cloud chargées ✅");
      } else {
        await cloudWrite();
        toast("Cloud initialisé ✅");
      }

      cloud.unsub = onSnapshot(ref, (docSnap) => {
        if (!docSnap.exists()) return;
        if (cloud.applying) return;

        const incoming = normalizeState(docSnap.data());
        if (JSON.stringify(incoming) === JSON.stringify(state)) return;

        cloud.applying = true;
        state = incoming;
        cloud.applying = false;

        saveLocal();
        rerender();
        toast("Mise à jour reçue du cloud 🔄");
      });

      window.__cloudSave = async () => {
        if (!cloud.enabled || !cloud.user) return false;
        try { await cloudWrite(); return true; }
        catch (e) { console.error(e); toast("Erreur cloud ⚠️"); return false; }
      };
    });
  } catch (e) {
    console.error("Firebase init error:", e);
    setCloudBadge("Cloud : erreur de chargement", false);
    setAuthMsg("Erreur Firebase (voir console).");
  }
}

async function saveState() {
  saveLocal();
  if (typeof window.__cloudSave === "function" && !cloud.applying) {
    await window.__cloudSave();
  }
}

// --------------------
// Tabs / rendering
// --------------------
function currentTab() {
  return document.querySelector('.tab[aria-selected="true"]')?.dataset.tab || "bailleur";
}
function setTab(tab) {
  $$(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.tab === tab ? "true" : "false"));
  render(tab);
}
function rerender() { render(currentTab()); }

// --------------------
// PDF export (FIX)
// --------------------
async function exportPdfFromTemplate(filename) {
  if (!window.html2pdf) {
    alert("html2pdf.js n'est pas chargé. Vérifie le script CDN.");
    return;
  }

  const host = $("#pdfTemplate");
  if (!host) throw new Error("pdfTemplate introuvable");
  const node = host.firstElementChild;
  if (!node) throw new Error("pdfTemplate vide");

  const wasHidden = host.classList.contains("hidden");
  const prevStyle = host.getAttribute("style");

  // rendre visible hors écran (évite PDF blanc/coupé)
  host.classList.remove("hidden");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "0";
  host.style.width = "210mm";
  host.style.pointerEvents = "none";
  host.style.opacity = "1"; // important : certaines configs rendent vide si opacity=0

  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const opt = {
    margin: [6, 6, 6, 6],
    filename,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
  };

  try {
    await window.html2pdf().set(opt).from(node).save();
  } finally {
    if (wasHidden) host.classList.add("hidden");
    if (prevStyle) host.setAttribute("style", prevStyle);
    else host.removeAttribute("style");
  }
}

// --------------------
// Renders
// --------------------
function renderLandlord() {
  $("#leftTitle").textContent = "Informations bailleur";
  $("#leftHint").textContent = "Signature manuscrite auto dans le PDF";

  $("#leftBody").innerHTML = `
    <div class="row">
      <div>
        <label>Nom / Prénom (ou raison sociale)</label>
        <input id="l_fullName" value="${escapeHtml(state.landlord.fullName)}" placeholder="Ex : Jean Dupont">
      </div>
      <div>
        <label>Ville (pour “Fait à …”)</label>
        <input id="l_city" value="${escapeHtml(state.landlord.city)}" placeholder="Ex : Paris">
      </div>
    </div>

    <div class="row">
      <div>
        <label>Email</label>
        <input id="l_email" value="${escapeHtml(state.landlord.email)}" placeholder="ex: jean@exemple.fr">
      </div>
      <div>
        <label>Téléphone</label>
        <input id="l_phone" value="${escapeHtml(state.landlord.phone)}" placeholder="ex: 06...">
      </div>
    </div>

    <div>
      <label>Adresse bailleur</label>
      <textarea id="l_address" placeholder="Adresse complète">${escapeHtml(state.landlord.address)}</textarea>
    </div>

    <div class="row" style="margin-top:12px">
      <div>
        <label>Nom affiché pour la signature (optionnel)</label>
        <input id="l_signatureName" value="${escapeHtml(state.landlord.signatureName)}" placeholder="Par défaut : Nom / Prénom">
        <div class="mini" style="margin-top:6px">
          Aperçu signature :
          <span style="font-family:'Great Vibes','Brush Script MT',cursive;font-size:28px;color:rgba(234,240,255,.95)">
            ${escapeHtml(state.landlord.signatureName || state.landlord.fullName || "—")}
          </span>
        </div>
      </div>
      <div></div>
    </div>

    <div class="actions">
      <button class="btn primary" id="btnSaveLandlord">Enregistrer</button>
    </div>
  `;

  $("#btnSaveLandlord").addEventListener("click", async () => {
    state.landlord.fullName = $("#l_fullName").value.trim();
    state.landlord.city = $("#l_city").value.trim();
    state.landlord.email = $("#l_email").value.trim();
    state.landlord.phone = $("#l_phone").value.trim();
    state.landlord.address = $("#l_address").value.trim();
    state.landlord.signatureName = $("#l_signatureName").value.trim();
    await saveState();
    toast("Bailleur enregistré ✅");
    renderLandlord();
  });
}

function renderTenants() {
  $("#leftTitle").textContent = "Locataires";
  $("#leftHint").textContent = `${state.tenants.length} enregistré(s)`;

  const listHtml = state.tenants.length ? `
    <div class="list">
      ${state.tenants.map(t => `
        <div class="item">
          <div class="meta">
            <div class="name">${escapeHtml(t.fullName || "Sans nom")}</div>
            <div class="sub">Logements : ${t.properties?.length || 0}<br/>Paiement : ${escapeHtml(t.paymentMethod || "—")}</div>
          </div>
          <div class="right">
            <button class="btn" data-edit="${t.id}">Modifier</button>
            <button class="btn danger" data-del="${t.id}">Supprimer</button>
          </div>
        </div>
      `).join("")}
    </div>
  ` : `<div class="note">Aucun locataire. Ajoute le premier ci-dessous.</div>`;

  $("#leftBody").innerHTML = `
    ${listHtml}
    <div style="height:14px"></div>
    <div class="card" style="border-radius:18px">
      <div class="head" style="border-bottom:1px solid var(--border)">
        <h2 id="tenantFormTitle">Ajouter un locataire</h2>
        <div class="hint" id="tenantFormHint">plusieurs logements</div>
      </div>
      <div class="body" id="tenantForm"></div>
    </div>
  `;

  renderTenantForm(null);

  $$("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-edit");
      const t = state.tenants.find(x => x.id === id);
      renderTenantForm(t || null);
      $("#tenantFormTitle").textContent = "Modifier le locataire";
      $("#tenantFormHint").textContent = id;
    });
  });

  $$("[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      const t = state.tenants.find(x => x.id === id);
      if (!confirm(`Supprimer ${t?.fullName || "ce locataire"} ?`)) return;

      state.tenants = state.tenants.filter(x => x.id !== id);

      // Option : aussi supprimer les quittances liées
      state.receipts = state.receipts.filter(r => r.tenantId !== id);

      await saveState();
      toast("Locataire supprimé 🗑️");
      renderTenants();
    });
  });
}

function renderTenantForm(tenant) {
  const isEdit = !!tenant;
  const t = tenant ? structuredClone(tenant) : {
    id: uid(),
    fullName: "",
    tenantAddress: "",
    paymentMethod: "Virement",
    properties: [{ id: uid(), label: "Logement 1", address: "", rentHc: 0, charges: 0 }]
  };

  $("#tenantForm").innerHTML = `
    <div class="row">
      <div>
        <label>Nom du locataire</label>
        <input id="t_fullName" value="${escapeHtml(t.fullName)}" placeholder="Ex : Marie Martin">
      </div>
      <div>
        <label>Moyen de paiement</label>
        <select id="t_paymentMethod">
          ${["Virement", "Chèque", "Espèces", "Prélèvement", "Autre"].map(v =>
            `<option value="${v}" ${t.paymentMethod === v ? "selected" : ""}>${v}</option>`
          ).join("")}
        </select>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Adresse du locataire (optionnel)</label>
        <textarea id="t_tenantAddress" placeholder="Adresse complète">${escapeHtml(t.tenantAddress)}</textarea>
      </div>
      <div>
        <label>Logements</label>
        <div id="propsList"></div>
        <div class="actions" style="margin-top:8px">
          <button class="btn" id="btnAddProp">+ Ajouter un logement</button>
        </div>
        <div class="mini">Les montants du logement sont les valeurs par défaut (modifiables au moment de générer la quittance).</div>
      </div>
    </div>

    <div class="actions">
      <button class="btn primary" id="btnSaveTenant">${isEdit ? "Enregistrer" : "Ajouter"}</button>
      ${isEdit ? `<button class="btn" id="btnCancelEdit">Annuler</button>` : ""}
    </div>
  `;

  function renderProps() {
    const box = $("#propsList");
    box.innerHTML = t.properties.map(p => `
      <div class="item" style="margin-bottom:10px">
        <div class="meta" style="width:100%">
          <div class="row" style="margin:0">
            <div>
              <label>Libellé</label>
              <input data-p="${p.id}" data-k="label" value="${escapeHtml(p.label)}" placeholder="Ex : Studio Rue X">
            </div>
            <div>
              <label>Loyer HC (€)</label>
              <input data-p="${p.id}" data-k="rentHc" type="number" step="0.01" min="0" value="${Number(p.rentHc || 0)}">
            </div>
          </div>
          <div class="row" style="margin-top:10px">
            <div>
              <label>Adresse du logement</label>
              <textarea data-p="${p.id}" data-k="address" placeholder="Adresse complète">${escapeHtml(p.address || "")}</textarea>
            </div>
            <div>
              <label>Charges (€)</label>
              <input data-p="${p.id}" data-k="charges" type="number" step="0.01" value="${Number(p.charges || 0)}">
              <div class="mini" style="margin-top:8px">
                Total défaut :
                <span style="font-family:var(--mono);color:rgba(234,240,255,.92)">
                  ${escapeHtml(euro(Number(p.rentHc || 0) + Number(p.charges || 0)))}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div class="right">
          <button class="btn danger" data-delprop="${p.id}" ${t.properties.length <= 1 ? "disabled" : ""}>Supprimer</button>
        </div>
      </div>
    `).join("");

    $$("[data-p][data-k]", box).forEach(el => {
      el.addEventListener("input", () => {
        const pid = el.getAttribute("data-p");
        const k = el.getAttribute("data-k");
        const prop = t.properties.find(x => x.id === pid);
        if (!prop) return;

        if (k === "rentHc" || k === "charges") prop[k] = Number(el.value || 0);
        else prop[k] = el.value;
      });
    });

    $$("[data-delprop]", box).forEach(btn => {
      btn.addEventListener("click", () => {
        const pid = btn.getAttribute("data-delprop");
        if (t.properties.length <= 1) return;
        t.properties = t.properties.filter(x => x.id !== pid);
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
    t.fullName = $("#t_fullName").value.trim();
    t.paymentMethod = $("#t_paymentMethod").value;
    t.tenantAddress = $("#t_tenantAddress").value.trim();

    if (!t.fullName) { alert("Nom du locataire obligatoire."); return; }
    if (!t.properties.length || t.properties.some(p => !String(p.address || "").trim())) {
      alert("Chaque logement doit avoir une adresse.");
      return;
    }

    t.properties = t.properties.map(p => ({
      ...p,
      label: String(p.label || "Logement").trim() || "Logement",
      address: String(p.address || "").trim(),
      rentHc: Number(p.rentHc || 0),
      charges: Number(p.charges || 0)
    }));

    if (isEdit) {
      const idx = state.tenants.findIndex(x => x.id === t.id);
      if (idx >= 0) state.tenants[idx] = t;
    } else {
      state.tenants.unshift(t);
    }

    await saveState();
    toast(isEdit ? "Locataire mis à jour ✅" : "Locataire ajouté ✅");
    renderTenants();
  });

  if (isEdit) {
    $("#btnCancelEdit").addEventListener("click", () => renderTenants());
  }
}

function renderReceipts() {
  $("#leftTitle").textContent = "Générer une quittance PDF";
  $("#leftHint").textContent = "Montants modifiables + lignes (régularisation / remise)";

  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();

  $("#leftBody").innerHTML = `
    <div class="row">
      <div>
        <label>Locataire</label>
        <select id="r_tenantId">
          ${state.tenants.length
            ? state.tenants.map(t => `<option value="${t.id}">${escapeHtml(t.fullName)}</option>`).join("")
            : `<option value="">Aucun locataire</option>`}
        </select>
      </div>
      <div>
        <label>Logement</label>
        <select id="r_propertyId"></select>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Période (mois / année)</label>
        <div class="row" style="margin:0; grid-template-columns:1fr 1fr; gap:10px">
          <select id="r_month">
            ${Array.from({ length: 12 }).map((_, i) => {
              const monthName = new Date(2000, i, 1).toLocaleDateString("fr-FR", { month: "long" });
              return `<option value="${i}" ${i === m ? "selected" : ""}>${monthName}</option>`;
            }).join("")}
          </select>
          <input id="r_year" type="number" min="2000" max="2100" value="${y}">
        </div>
      </div>
      <div>
        <label>Date d’édition</label>
        <input id="r_date" type="date" value="${toISODate(today)}">
      </div>
    </div>

    <div class="row">
      <div>
        <label>Référence (optionnel)</label>
        <input id="r_ref" placeholder="Ex : Q-${y}-${String(m + 1).padStart(2, "0")}-001">
      </div>
      <div>
        <label>Total (aperçu)</label>
        <input id="r_totalPreview" disabled value="—" style="font-family:var(--mono)">
      </div>
    </div>

    <div class="card" style="border-radius:18px">
      <div class="head" style="border-bottom:1px solid var(--border)">
        <h2>Montants</h2>
        <div class="hint">modifiable au cas par cas</div>
      </div>
      <div class="body">
        <div class="row">
          <div>
            <label>Loyer (hors charges) €</label>
            <input id="r_rent" type="number" step="0.01" min="0" value="0">
          </div>
          <div>
            <label>Charges €</label>
            <input id="r_charges" type="number" step="0.01" value="0">
          </div>
        </div>

        <div>
          <label>Lignes supplémentaires</label>
          <div id="adjList"></div>
          <div class="actions" style="margin-top:8px">
            <button class="btn" id="btnAddAdj">+ Ajouter une ligne</button>
            <button class="btn" id="btnQuickReg">+ Régularisation charges</button>
            <button class="btn" id="btnQuickDiscount">+ Remise</button>
          </div>
          <div class="mini">Montants négatifs = remise / avoir.</div>
        </div>
      </div>
    </div>

    <div class="actions" style="margin-top:12px">
      <button class="btn primary" id="btnGenerate" ${state.tenants.length ? "" : "disabled"}>Générer le PDF</button>
    </div>

    <div class="note">Conseil : une quittance atteste un paiement (à générer après encaissement).</div>
  `;

  const draft = { adjustments: [] };
  const tenantSel = $("#r_tenantId");
  const propSel = $("#r_propertyId");

  const getTenant = () => state.tenants.find(t => t.id === tenantSel.value);
  const getProp = () => getTenant()?.properties?.find(p => p.id === propSel.value);

  function setPropOptions() {
    const t = getTenant();
    const props = t?.properties || [];
    propSel.innerHTML = props.map(p => `<option value="${p.id}">${escapeHtml(p.label || "Logement")}</option>`).join("");
    propSel.value = props[0]?.id || "";
    applyDefaults();
  }

  function applyDefaults() {
    const p = getProp();
    $("#r_rent").value = String(Number(p?.rentHc || 0));
    $("#r_charges").value = String(Number(p?.charges || 0));
    computeTotal();
  }

  function renderAdjs() {
    const box = $("#adjList");
    if (!draft.adjustments.length) {
      box.innerHTML = `<div class="mini">Aucune ligne supplémentaire.</div>`;
      return;
    }
    box.innerHTML = draft.adjustments.map((a, i) => `
      <div class="item">
        <div class="meta" style="width:100%">
          <div class="row" style="margin:0; grid-template-columns: 1.4fr .6fr;">
            <div>
              <label>Libellé</label>
              <input data-ai="${i}" data-k="label" value="${escapeHtml(a.label)}" placeholder="Ex : Régularisation charges">
            </div>
            <div>
              <label>Montant €</label>
              <input data-ai="${i}" data-k="amount" type="number" step="0.01" value="${Number(a.amount || 0)}">
            </div>
          </div>
        </div>
        <div class="right"><button class="btn danger" data-delai="${i}">Supprimer</button></div>
      </div>
    `).join("");

    $$("[data-ai][data-k]", box).forEach(el => {
      el.addEventListener("input", () => {
        const i = Number(el.getAttribute("data-ai"));
        const k = el.getAttribute("data-k");
        if (!draft.adjustments[i]) return;
        if (k === "amount") draft.adjustments[i].amount = Number(el.value || 0);
        else draft.adjustments[i].label = el.value;
        computeTotal();
      });
    });

    $$("[data-delai]", box).forEach(btn => {
      btn.addEventListener("click", () => {
        const i = Number(btn.getAttribute("data-delai"));
        draft.adjustments.splice(i, 1);
        renderAdjs();
        computeTotal();
      });
    });
  }

  function computeTotal() {
    const rent = Number($("#r_rent").value || 0);
    const charges = Number($("#r_charges").value || 0);
    const extra = draft.adjustments.reduce((s, a) => s + Number(a.amount || 0), 0);
    const total = rent + charges + extra;
    $("#r_totalPreview").value = euro(total);
    return { rent, charges, total };
  }

  if (state.tenants.length) {
    tenantSel.value = state.tenants[0].id;
    setPropOptions();
  }

  renderAdjs();
  computeTotal();

  tenantSel.addEventListener("change", setPropOptions);
  propSel.addEventListener("change", applyDefaults);
  $("#r_rent").addEventListener("input", computeTotal);
  $("#r_charges").addEventListener("input", computeTotal);

  $("#btnAddAdj").addEventListener("click", () => { draft.adjustments.push({ label: "Autre", amount: 0 }); renderAdjs(); computeTotal(); });
  $("#btnQuickReg").addEventListener("click", () => { draft.adjustments.push({ label: "Régularisation de charges", amount: 0 }); renderAdjs(); computeTotal(); });
  $("#btnQuickDiscount").addEventListener("click", () => { draft.adjustments.push({ label: "Remise exceptionnelle", amount: 0 }); renderAdjs(); computeTotal(); });

  $("#btnGenerate")?.addEventListener("click", async () => {
    const tenant = getTenant();
    const prop = getProp();
    if (!tenant || !prop) return;

    if (document.fonts?.ready) { try { await document.fonts.ready; } catch { } }

    const monthIndex = Number($("#r_month").value);
    const year = Number($("#r_year").value);
    const dateStr = $("#r_date").value;

    const periodLabel = cap(monthLabel(year, monthIndex));
    const ref = ($("#r_ref").value || "").trim()
      || `Q-${year}-${String(monthIndex + 1).padStart(2, "0")}-${tenant.fullName.replaceAll(" ", "_")}`;

    const rent = Number($("#r_rent").value || 0);
    const charges = Number($("#r_charges").value || 0);

    const lines = [
      { label: "Loyer (hors charges)", amount: rent },
      { label: "Charges", amount: charges },
      ...draft.adjustments
        .map(a => ({ label: String(a.label || "").trim(), amount: Number(a.amount || 0) }))
        .filter(a => a.label && a.amount !== 0)
    ];
    const total = lines.reduce((s, l) => s + Number(l.amount || 0), 0);

    // Fill PDF template
    $("#pdfPeriod").textContent = `Période : ${periodLabel}`;
    $("#pdfRef").textContent = ref;

    const L = state.landlord;

    $("#pdfLandlordLines").textContent = [
      L.fullName || "—",
      L.address || "",
      L.email ? `Email : ${L.email}` : "",
      L.phone ? `Tél : ${L.phone}` : ""
    ].filter(Boolean).join("\n") || "—";

    $("#pdfTenantLines").textContent = [
      tenant.fullName || "—",
      tenant.tenantAddress || ""
    ].filter(Boolean).join("\n") || "—";

    $("#pdfProperty").textContent = prop.address || "—";
    $("#pdfPropertyLabel").textContent = prop.label ? `(${prop.label})` : "";

    $("#pdfLines").innerHTML = lines.map(l => `
      <tr><td>${escapeHtml(l.label)}</td><td>${escapeHtml(euro(l.amount))}</td></tr>
    `).join("");

    $("#pdfTotal").textContent = euro(total);
    $("#pdfTotalLine").textContent = `Total : ${euro(total)}`;

    const city = L.city || "—";
    const editedDate = dateStr ? formatFRDate(dateStr) : "—";
    $("#pdfFooterLeft").innerHTML =
      `Fait à ${escapeHtml(city)}, le ${escapeHtml(editedDate)}<br/>Paiement : ${escapeHtml(tenant.paymentMethod || "—")}<br/><span style="color:#64748b">Document généré automatiquement.</span>`;

    $("#pdfSignText").textContent = L.signatureName || L.fullName || "—";

    const filename = safeFileName(`Quittance_${tenant.fullName}_${periodLabel}.pdf`);

    try {
      await exportPdfFromTemplate(filename);

      const receipt = {
        id: uid(),
        tenantId: tenant.id,
        tenantName: tenant.fullName,
        tenantAddress: tenant.tenantAddress || "",

        propertyId: prop.id,
        propertyLabel: prop.label,
        propertyAddress: prop.address,

        year,
        month: monthIndex,
        period: periodLabel,
        reference: ref,
        dateIssued: dateStr,

        rentHc: rent,
        charges,
        adjustments: normalizeAdjustments(draft.adjustments),
        total,
        paymentMethod: tenant.paymentMethod,
        createdAt: Date.now()
      };

      state.receipts.unshift(receipt);
      await saveState();
      toast("PDF généré et enregistré ✅");
    } catch (e) {
      console.error(e);
      alert("Impossible de générer le PDF (voir console).");
    }
  });
}

// ------------------------------------------
// Historique
// ------------------------------------------
function renderHistory() {
  $("#leftTitle").textContent = "Historique des quittances";
  $("#leftHint").textContent = `${state.receipts.length} quittance(s)`;

  const receipts = [...state.receipts].sort((a, b) => b.createdAt - a.createdAt);
  const currentYear = new Date().getFullYear();
  const totalThisYear = receipts.filter(r => r.year === currentYear).reduce((sum, r) => sum + r.total, 0);

  if (!receipts.length) {
    $("#leftBody").innerHTML = `
      <div class="note">
        Aucune quittance générée pour le moment.<br/>
        Créez votre première quittance dans l'onglet "Quittances PDF".
      </div>
    `;
    return;
  }

  const byYear = {};
  receipts.forEach(r => {
    if (!byYear[r.year]) byYear[r.year] = [];
    byYear[r.year].push(r);
  });

  const yearsHtml = Object.keys(byYear).sort((a, b) => b - a).map(year => {
    const yearReceipts = byYear[year];
    const yearTotal = yearReceipts.reduce((sum, r) => sum + r.total, 0);

    return `
      <div class="card" style="border-radius:18px;margin-bottom:20px">
        <div class="head" style="border-bottom:1px solid var(--border);background:rgba(0,0,0,.15)">
          <h2 style="margin:0">${year}</h2>
          <div class="badge ok">${yearReceipts.length} quittances • ${euro(yearTotal)}</div>
        </div>
        <div class="body">
          <div class="list">
            ${yearReceipts.map(r => `
              <div class="item">
                <div class="meta">
                  <div class="name">${escapeHtml(r.tenantName)}</div>
                  <div class="sub">
                    📅 ${escapeHtml(r.period)}<br/>
                    🏠 ${escapeHtml(r.propertyLabel || r.propertyAddress)}<br/>
                    💰 ${euro(r.total)} • Réf: ${escapeHtml(r.reference)}
                  </div>
                </div>
                <div class="right">
                  <button class="btn" data-view="${r.id}" title="Voir les détails">👁️</button>
                  <button class="btn" data-regen="${r.id}" title="Télécharger">📥</button>
                  <button class="btn danger" data-delrec="${r.id}" title="Supprimer">🗑️</button>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }).join("");

  $("#leftBody").innerHTML = `
    <div class="stats-row" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px">
      <div class="badge ok" style="padding:12px;font-size:14px">
        <div>Total ${currentYear}</div>
        <div style="font-size:18px;margin-top:4px;font-family:var(--mono)">${euro(totalThisYear)}</div>
      </div>
      <div class="badge" style="padding:12px;font-size:14px">
        <div>Quittances</div>
        <div style="font-size:18px;margin-top:4px;font-family:var(--mono)">${receipts.length}</div>
      </div>
    </div>

    ${yearsHtml}

    <div class="note" style="margin-top:20px">
      💡 <strong>Astuce :</strong> Cliquez sur 📥 pour re-télécharger une quittance, ou 👁️ pour voir les détails.
    </div>
  `;

  $$("[data-view]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-view");
      const receipt = state.receipts.find(r => r.id === id);
      if (!receipt) return;
      showReceiptDetails(receipt);
    });
  });

  $$("[data-regen]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-regen");
      const receipt = state.receipts.find(r => r.id === id);
      if (!receipt) return;
      await regeneratePDF(receipt);
    });
  });

  $$("[data-delrec]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-delrec");
      const receipt = state.receipts.find(r => r.id === id);
      if (!receipt) return;

      if (!confirm(`Supprimer la quittance :\n\n${receipt.tenantName}\n${receipt.period}\n${euro(receipt.total)}\n\nCette action est irréversible.`)) return;

      state.receipts = state.receipts.filter(r => r.id !== id);
      await saveState();
      toast("Quittance supprimée 🗑️");
      renderHistory();
    });
  });
}

// ------------------------------------------
// Modal détail (sans onclick inline)
// ------------------------------------------
function showReceiptDetails(receipt) {
  const modal = document.createElement("div");
  modal.style.cssText =
    "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;";

  const content = document.createElement("div");
  content.style.cssText =
    "background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);max-width:600px;width:100%;max-height:90vh;overflow-y:auto;padding:24px;";

  const allLines = [
    { label: "Loyer (hors charges)", amount: receipt.rentHc },
    { label: "Charges", amount: receipt.charges },
    ...(receipt.adjustments || [])
  ];

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px">
      <div>
        <h2 style="margin:0;font-size:22px">${escapeHtml(receipt.tenantName)}</h2>
        <div style="color:var(--text-muted);margin-top:6px">${escapeHtml(receipt.period)}</div>
      </div>
      <button class="btn danger" data-close style="margin:0">✖️</button>
    </div>

    <div style="background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">RÉFÉRENCE</div>
      <div style="font-family:var(--mono);font-size:14px">${escapeHtml(receipt.reference)}</div>
    </div>

    <div style="background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">LOGEMENT</div>
      <div style="font-weight:600">${escapeHtml(receipt.propertyLabel || "Logement")}</div>
      <div style="color:var(--text-muted);font-size:13px;margin-top:4px">${escapeHtml(receipt.propertyAddress)}</div>
    </div>

    <div style="background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:16px">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">DÉTAIL</div>
      ${allLines.map(l => `
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
          <span>${escapeHtml(l.label)}</span>
          <span style="font-family:var(--mono);font-weight:600">${euro(l.amount)}</span>
        </div>
      `).join("")}
      <div style="display:flex;justify-content:space-between;padding:12px 0;margin-top:8px;font-size:18px;font-weight:700">
        <span>TOTAL</span>
        <span style="font-family:var(--mono);color:var(--accent)">${euro(receipt.total)}</span>
      </div>
    </div>

    <div style="background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:12px;padding:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:13px">
        <div>
          <div style="color:var(--text-muted);margin-bottom:4px">Date d'émission</div>
          <div>${formatFRDate(receipt.dateIssued)}</div>
        </div>
        <div>
          <div style="color:var(--text-muted);margin-bottom:4px">Paiement</div>
          <div>${escapeHtml(receipt.paymentMethod)}</div>
        </div>
      </div>
    </div>

    <div style="margin-top:20px;display:flex;gap:10px">
      <button class="btn primary" data-download>📥 Télécharger le PDF</button>
      <button class="btn" data-close>Fermer</button>
    </div>
  `;

  modal.appendChild(content);
  document.body.appendChild(modal);

  const close = () => modal.remove();
  $$("[data-close]", content).forEach(b => b.addEventListener("click", close));

  $("[data-download]", content)?.addEventListener("click", async () => {
    await regeneratePDF(receipt);
    close();
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
}

// ------------------------------------------
// Régénérer PDF depuis historique
// ------------------------------------------
async function regeneratePDF(receipt) {
  if (!receipt) {
    toast("Quittance introuvable ⚠️");
    return;
  }

  if (document.fonts?.ready) { try { await document.fonts.ready; } catch { } }

  $("#pdfPeriod").textContent = `Période : ${receipt.period}`;
  $("#pdfRef").textContent = receipt.reference;

  const L = state.landlord;

  $("#pdfLandlordLines").textContent = [
    L.fullName || "—",
    L.address || "",
    L.email ? `Email : ${L.email}` : "",
    L.phone ? `Tél : ${L.phone}` : ""
  ].filter(Boolean).join("\n") || "—";

  $("#pdfTenantLines").textContent = [
    receipt.tenantName || "—",
    receipt.tenantAddress || ""
  ].filter(Boolean).join("\n") || "—";

  $("#pdfProperty").textContent = receipt.propertyAddress || "—";
  $("#pdfPropertyLabel").textContent = receipt.propertyLabel ? `(${receipt.propertyLabel})` : "";

  const lines = [
    { label: "Loyer (hors charges)", amount: receipt.rentHc },
    { label: "Charges", amount: receipt.charges },
    ...(receipt.adjustments || [])
  ];

  $("#pdfLines").innerHTML = lines.map(l => `
    <tr>
      <td>${escapeHtml(l.label)}</td>
      <td>${escapeHtml(euro(l.amount))}</td>
    </tr>
  `).join("");

  $("#pdfTotal").textContent = euro(receipt.total);
  $("#pdfTotalLine").textContent = `Total : ${euro(receipt.total)}`;

  const city = L.city || "—";
  const editedDate = receipt.dateIssued ? formatFRDate(receipt.dateIssued) : "—";
  $("#pdfFooterLeft").innerHTML =
    `Fait à ${escapeHtml(city)}, le ${escapeHtml(editedDate)}<br/>Paiement : ${escapeHtml(receipt.paymentMethod || "—")}<br/><span style="color:#64748b">Document généré automatiquement.</span>`;

  $("#pdfSignText").textContent = L.signatureName || L.fullName || "—";

  const filename = safeFileName(`Quittance_${receipt.tenantName}_${receipt.period}.pdf`);

  try {
    await exportPdfFromTemplate(filename);
    toast("PDF téléchargé ✅");
  } catch (e) {
    console.error(e);
    alert("Impossible de générer le PDF (voir console)");
  }
}

// --------------------
// Router render
// --------------------
function render(tab) {
  if (tab === "bailleur") return renderLandlord();
  if (tab === "locataires") return renderTenants();
  if (tab === "quittances") return renderReceipts();
  if (tab === "historique") return renderHistory();
}

// --------------------
// Start + events
// --------------------
function start() {
  // Export / Import / Reset
  $("#btnExport")?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "quittances_data.json";
    a.click();
    URL.revokeObjectURL(url);
    toast("Export terminé 📦");
  });

  $("#btnImport")?.addEventListener("click", () => $("#fileImport")?.click());

  $("#fileImport")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      state = normalizeState(JSON.parse(text));
      await saveState();
      rerender();
      toast("Import réussi ✅");
    } catch {
      alert("Fichier invalide.");
    } finally {
      e.target.value = "";
    }
  });

  $("#btnReset")?.addEventListener("click", async () => {
    if (!confirm("Tout effacer ?")) return;
    state = structuredClone(defaultState);
    await saveState();
    setTab("bailleur");
    toast("Réinitialisé ✅");
  });

  // Tabs
  $$(".tab").forEach(t => {
    t.addEventListener("click", () => setTab(t.dataset.tab));
    t.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") setTab(t.dataset.tab);
    });
  });

  // Start view
  render("bailleur");
  initFirebase();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
