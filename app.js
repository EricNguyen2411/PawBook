(() => {
  const { Dogs, Entries, Photos, Weights } = window.DB;
  const H = window.Helpers;

  // ---- In-memory state ----
  let dogs = [];
  let currentDogId = localStorage.getItem('pawbook_currentDogId') || null;
  let activeTab = 'timeline';
  let pendingPhotos = []; // [{thumbBlob, fullBlob, previewUrl}] for the entry sheet in progress
  let pendingEntryLocation = null; // {lat, lon} picked up from EXIF, for the single-entry add flow
  let entryDateManuallyEdited = false; // true once the user types in #entryDate themselves
  let editingDogId = null; // set when the dog sheet is in "edit" mode
  let pendingDogPhoto = null; // {thumbBlob, fullBlob, previewUrl} — newly picked avatar, not yet saved
  let dogPhotoRemoved = false; // true when editing and the user cleared the existing avatar
  let timelineQuery = '';
  let timelineTypeFilter = 'all';
  let recapDogId = null; // which dog the open recap sheet is showing
  let bulkImportGroups = []; // [{date, photoIds: [], previewUrls: [], location, skipped}] during a bulk import review
  let editingEntryId = null; // set when the entry sheet is in "edit" mode
  let editingEntryOriginal = null; // the full original entry record being edited, for merging on save
  let removedExistingPhotoIds = []; // existing photos removed while editing, cleaned up from storage on save
  let photoViewerContext = { photoIds: [], index: 0 };
  let pendingVaccineSchedule = []; // [{label, dueDate, skipped}] while reviewing the suggested schedule

  // Session-lived cache of photoId -> full-resolution object URL, for the
  // full-screen photo viewer (separate from photoUrlCache, which holds thumbs).
  const fullUrlCache = new Map();
  // id -> entry record, refreshed whenever entries are fetched for rendering.
  // Lets click handlers (favorite, edit, photo viewer) look an entry up
  // without needing the whole entries array threaded through every call.
  const entryLookupById = new Map();

  // Session-lived cache of photoId -> thumbnail object URL, so repeated
  // renders (dog switcher, timeline, profile) don't keep creating fresh
  // object URLs for the same underlying blob.
  const photoUrlCache = new Map();

  // ---- DOM refs ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const dogSwitcherEl = $('#dogSwitcher');
  const screens = {
    timeline: $('#screen-timeline'),
    weight: $('#screen-weight'),
    stats: $('#screen-stats'),
    profile: $('#screen-profile'),
    backup: $('#screen-backup'),
  };
  const tabBtns = $$('.tab-btn');
  const fab = $('#fab');
  const toastEl = $('#toast');

  // ================= Utilities =================

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  function openSheet(sheetEl) {
    $('#sheetBackdrop').classList.add('open');
    sheetEl.classList.add('open');
  }

  function closeSheet(sheetEl) {
    sheetEl.classList.remove('open');
    if (!$$('.sheet.open').length) $('#sheetBackdrop').classList.remove('open');
  }

  function closeAllSheets() {
    if ($('#bulkImportSheet').classList.contains('open')) {
      cancelBulkImport();
      return;
    }
    $$('.sheet').forEach(closeSheet);
  }

  function currentDog() {
    return dogs.find((d) => d.id === currentDogId) || null;
  }

  function objectUrlFor(blob) {
    return blob ? URL.createObjectURL(blob) : '';
  }

  async function getPhotoThumbUrl(photoId) {
    if (!photoId) return '';
    if (photoUrlCache.has(photoId)) return photoUrlCache.get(photoId);
    const rec = await Photos.get(photoId).catch(() => null);
    const url = rec && rec.thumbBlob ? objectUrlFor(rec.thumbBlob) : '';
    photoUrlCache.set(photoId, url);
    return url;
  }

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function emptyStateHtml(paw, title, body) {
    return `<div class="empty-state"><div class="paw">${paw}</div><h2>${title}</h2><p>${body}</p></div>`;
  }

  // ================= Boot =================

  async function boot() {
    dogs = await Dogs.all();

    if (!dogs.length) {
      showOnboarding();
      return;
    }

    if (!currentDogId || !dogs.some((d) => d.id === currentDogId)) {
      currentDogId = dogs[0].id;
    }
    persistCurrentDog();

    await renderDogSwitcher();
    setTab('timeline');
    wireEvents();
  }

  function persistCurrentDog() {
    if (currentDogId) localStorage.setItem('pawbook_currentDogId', currentDogId);
  }

  function showOnboarding() {
    wireEvents();
    editingDogId = null;
    $('#dogSheetTitle').textContent = 'Add your first dog';
    $('#dogSheetDelete').style.display = 'none';
    resetDogForm();
    openSheet($('#dogSheet'));
  }

  // ================= Tabs =================

  function setTab(tab) {
    activeTab = tab;
    Object.entries(screens).forEach(([key, el]) => el.classList.toggle('active', key === tab));
    tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    fab.style.display = tab === 'timeline' ? 'flex' : 'none';
    render();
  }

  // ================= Dog switcher =================

  async function renderDogSwitcher() {
    dogSwitcherEl.innerHTML = '';
    for (const dog of dogs) {
      const avatarUrl = await getPhotoThumbUrl(dog.coverPhotoId);
      const chip = document.createElement('button');
      chip.className = 'dog-chip' + (dog.id === currentDogId ? ' active' : '');
      chip.innerHTML = `<span class="avatar">${avatarUrl ? `<img src="${avatarUrl}" alt="">` : initials(dog.name)}</span>${escapeHtml(dog.name)}`;
      chip.addEventListener('click', () => {
        currentDogId = dog.id;
        persistCurrentDog();
        renderDogSwitcher();
        render();
      });
      dogSwitcherEl.appendChild(chip);
    }

    const addChip = document.createElement('button');
    addChip.className = 'dog-chip add';
    addChip.textContent = '+ Add dog';
    addChip.addEventListener('click', () => {
      editingDogId = null;
      $('#dogSheetTitle').textContent = 'Add a dog';
      $('#dogSheetDelete').style.display = 'none';
      resetDogForm();
      openSheet($('#dogSheet'));
    });
    dogSwitcherEl.appendChild(addChip);
  }

  // ================= Render dispatch =================

  async function render() {
    if (activeTab === 'backup') {
      renderBackupScreen();
      return;
    }
    if (!currentDog()) return;
    if (activeTab === 'timeline') await renderTimeline();
    if (activeTab === 'weight') await renderWeight();
    if (activeTab === 'stats') await renderStats();
    if (activeTab === 'profile') await renderProfile();
  }

  // ================= Timeline =================

  const TYPE_META = {
    photo: { icon: '📷', label: 'Photo' },
    note: { icon: '📝', label: 'Note' },
    milestone: { icon: '⭐', label: 'Milestone' },
    walk: { icon: '🐾', label: 'Walk' },
    vet: { icon: '🩺', label: 'Vet visit' },
    vaccination: { icon: '💉', label: 'Vaccination' },
  };

  async function renderTimeline() {
    const content = $('#timelineContent');
    const allEntries = await Entries.forDog(currentDogId);

    if (!allEntries.length) {
      content.innerHTML = emptyStateHtml('🐾', 'No entries yet', 'Tap the + button to add your first photo or memory.');
      return;
    }

    const today = H.todayLocalStr();
    let html = '';

    // Care reminders — always based on the full, unfiltered entry list.
    const reminders = H.upcomingCareReminders(allEntries, today, 30);
    if (reminders.length) {
      const overdue = reminders.filter((r) => r.daysUntil < 0);
      const cls = overdue.length ? 'overdue' : 'soon';
      const items = reminders
        .slice(0, 4)
        .map((r) => {
          const label = r.entry.caption || 'Vaccination';
          const when =
            r.daysUntil < 0
              ? `${Math.abs(r.daysUntil)} day${Math.abs(r.daysUntil) === 1 ? '' : 's'} overdue`
              : r.daysUntil === 0
              ? 'due today'
              : `due in ${r.daysUntil} day${r.daysUntil === 1 ? '' : 's'}`;
          return `<li>${escapeHtml(label)} — ${when}</li>`;
        })
        .join('');
      html += `<div class="care-banner ${cls}">
        <div class="label">${overdue.length ? 'Overdue' : 'Due soon'}</div>
        <ul>${items}</ul>
      </div>`;
    }

    const filtered = H.filterEntries(allEntries, { query: timelineQuery, type: timelineTypeFilter });

    const onThisDay = H.onThisDayEntries(allEntries, today);
    if (onThisDay.length) {
      const years = onThisDay.map((e) => H.parseLocalDate(e.date).getFullYear()).join(', ');
      html += `<div class="on-this-day"><div>
          <div class="label">On this day</div>
          <div class="text">${onThisDay.length} ${onThisDay.length === 1 ? 'memory' : 'memories'} from ${years}</div>
        </div></div>`;
    }

    if (!filtered.length) {
      html += emptyStateHtml('🔍', 'No matches', 'Try a different search or filter.');
      content.innerHTML = html;
      return;
    }

    const groups = H.groupEntriesByMonth(filtered);
    for (const group of groups) {
      html += `<div class="month-heading">${group.label}</div>`;
      for (const entry of group.entries) {
        html += await entryCardHtml(entry, today);
      }
    }

    content.innerHTML = html;
    allEntries.forEach((e) => entryLookupById.set(e.id, e));
    wireEntryCardInteractions(content);
  }

  function entrySubtitleHtml(entry, today) {
    if (entry.type === 'walk') {
      const parts = [];
      if (entry.distanceKm) parts.push(`${entry.distanceKm} km`);
      if (entry.durationMin) parts.push(`${entry.durationMin} min`);
      return parts.length ? `<p class="caption"><strong>${parts.join(' · ')}</strong></p>` : '';
    }
    if (entry.type === 'vaccination' && entry.nextDueDate) {
      const days = H.daysUntil(entry.nextDueDate, today);
      const overdue = days < 0;
      const when = overdue
        ? `overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`
        : `next due ${H.formatDateLong(entry.nextDueDate)}`;
      return `<p class="caption"><strong style="color:${overdue ? 'var(--rust)' : 'var(--ink)'}">${when}</strong></p>`;
    }
    return '';
  }

  async function entryCardHtml(entry, today) {
    const photoRecords = await Promise.all((entry.photoIds || []).map((id) => Photos.get(id).catch(() => null)));
    const validPhotos = photoRecords.filter(Boolean);

    let photosHtml = '';
    if (validPhotos.length) {
      const n = validPhotos.length === 1 ? 'n1' : validPhotos.length === 2 ? 'n2' : 'nmany';
      photosHtml = `<div class="entry-photos ${n}" data-photo-ids='${JSON.stringify(entry.photoIds || [])}'>${validPhotos
        .slice(0, 4)
        .map((p, i) => `<img src="${objectUrlFor(p.thumbBlob)}" data-index="${i}" alt="">`)
        .join('')}</div>`;
    }

    const tagsHtml =
      entry.tags && entry.tags.length
        ? `<div class="tags">${entry.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`
        : '';

    const meta = TYPE_META[entry.type] || TYPE_META.note;
    const isOverdueVaccination =
      entry.type === 'vaccination' && entry.nextDueDate && H.daysUntil(entry.nextDueDate, today) < 0;

    const locationHtml = entry.location
      ? `<a class="loc-badge" href="https://www.google.com/maps?q=${entry.location.lat},${entry.location.lon}" target="_blank" rel="noopener">📍</a>`
      : '';

    const cardClasses = [
      'entry-card',
      entry.type === 'milestone' ? 'milestone' : '',
      entry.type === 'walk' ? 'walk' : '',
      entry.type === 'vet' ? 'vet' : '',
      entry.type === 'vaccination' ? 'vaccination' : '',
      isOverdueVaccination ? 'overdue' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return `
      <div class="${cardClasses}" data-id="${entry.id}">
        <div class="date-stamp">${H.formatDateShort(entry.date)} · ${meta.icon} ${meta.label}</div>
        ${photosHtml}
        <div class="entry-body">
          ${entrySubtitleHtml(entry, today)}
          ${entry.caption ? `<p class="caption">${escapeHtml(entry.caption)}</p>` : ''}
          <div class="meta">
            <span>${H.formatDateLong(entry.date)} ${locationHtml}</span>
            <button class="fav-btn ${entry.favorite ? 'active' : ''}" data-id="${entry.id}">${entry.favorite ? '♥' : '♡'}</button>
          </div>
          ${tagsHtml}
        </div>
      </div>`;
  }

  // Wires favoriting, tap-a-photo-to-view-fullscreen, and tap-the-card-to-edit
  // for every .entry-card within a freshly-rendered container. Called after
  // any innerHTML assignment that includes entry cards (timeline, health,
  // milestones) — entries must already be registered in entryLookupById.
  function wireEntryCardInteractions(containerEl) {
    containerEl.querySelectorAll('.fav-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const entry = entryLookupById.get(btn.dataset.id);
        if (!entry) return;
        entry.favorite = !entry.favorite;
        await Entries.update(entry);
        btn.classList.toggle('active', entry.favorite);
        btn.textContent = entry.favorite ? '♥' : '♡';
      });
    });

    containerEl.querySelectorAll('.loc-badge').forEach((a) => {
      a.addEventListener('click', (e) => e.stopPropagation());
    });

    containerEl.querySelectorAll('.entry-photos img').forEach((img) => {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrap = img.closest('.entry-photos');
        const photoIds = JSON.parse(wrap.dataset.photoIds || '[]');
        const index = Number(img.dataset.index || 0);
        openPhotoViewer(photoIds, index);
      });
    });

    containerEl.querySelectorAll('.entry-card').forEach((card) => {
      card.addEventListener('click', () => {
        const entry = entryLookupById.get(card.dataset.id);
        if (entry) openEntryEditor(entry);
      });
    });
  }

  // ================= Weight =================

  async function renderWeight() {
    const root = $('#screen-weight');
    const weights = await Weights.forDog(currentDogId);

    if (!weights.length) {
      root.innerHTML =
        emptyStateHtml('⚖️', 'No weigh-ins yet', 'Log a weight to start tracking trends over time.') +
        `<button class="btn btn-primary btn-block" id="addFirstWeight">Log a weight</button>`;
      $('#addFirstWeight').addEventListener('click', () => openWeightSheet());
      return;
    }

    const latest = weights[weights.length - 1];
    const prev = weights.length > 1 ? weights[weights.length - 2] : null;
    const delta = prev ? latest.weightKg - prev.weightKg : null;
    const all = weights.map((w) => w.weightKg);
    const min = Math.min(...all);
    const max = Math.max(...all);

    const chart = H.buildWeightChartPoints(weights, 320, 140, 24);

    let svg = '';
    if (chart) {
      svg = `<svg viewBox="0 0 320 140">
        <path class="chart-line" d="${chart.path}" />
        ${chart.points.map((p) => `<circle class="chart-dot" cx="${p.x}" cy="${p.y}" r="3.5" />`).join('')}
        <text class="chart-axis-label" x="24" y="134">${H.formatDateShort(weights[0].date)}</text>
        <text class="chart-axis-label" x="296" y="134" text-anchor="end">${H.formatDateShort(weights[weights.length - 1].date)}</text>
      </svg>`;
    }

    root.innerHTML = `
      <div class="weight-summary">
        <div class="stat-card">
          <div class="value">${latest.weightKg.toFixed(1)}<span style="font-size:13px">kg</span></div>
          <div class="label">Current</div>
          ${delta !== null ? `<div class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta > 0 ? '+' : ''}${delta.toFixed(1)} kg</div>` : ''}
        </div>
        <div class="stat-card">
          <div class="value">${min.toFixed(1)}–${max.toFixed(1)}</div>
          <div class="label">Range (kg)</div>
        </div>
      </div>
      <div class="chart-card">${svg}</div>
      <button class="btn btn-primary btn-block" id="addWeightBtn" style="margin-bottom:16px;">+ Log weight</button>
      <div id="weightList"></div>
    `;

    const listEl = $('#weightList');
    [...weights].reverse().forEach((w) => {
      const row = document.createElement('div');
      row.className = 'weight-row';
      row.innerHTML = `
        <div>
          <div class="w-date">${H.formatDateLong(w.date)}</div>
          ${w.note ? `<div class="w-note">${escapeHtml(w.note)}</div>` : ''}
        </div>
        <div class="w-val">${w.weightKg.toFixed(1)} kg <span style="color:var(--ink-soft);font-weight:400;">(${H.kgToLb(w.weightKg).toFixed(1)} lb)</span></div>
      `;
      listEl.appendChild(row);
    });

    $('#addWeightBtn').addEventListener('click', () => openWeightSheet());
  }

  function openWeightSheet() {
    $('#weightDate').value = H.todayLocalStr();
    $('#weightKg').value = '';
    $('#weightNote').value = '';
    openSheet($('#weightSheet'));
  }

  // ================= Profile =================

  async function renderProfile() {
    const root = $('#screen-profile');
    const dog = currentDog();
    if (!dog) return;

    const entries = await Entries.forDog(currentDogId);
    entries.forEach((e) => entryLookupById.set(e.id, e));
    const milestones = entries.filter((e) => e.type === 'milestone' || e.favorite);
    const healthEntries = entries.filter((e) => e.type === 'vet' || e.type === 'vaccination');
    const age = dog.birthday ? H.calcAge(dog.birthday) : null;
    const avatarUrl = await getPhotoThumbUrl(dog.coverPhotoId);
    const tags = H.getAllTags(entries);

    const today = H.todayLocalStr();
    const weekAgo = (() => {
      const d = H.parseLocalDate(today);
      d.setDate(d.getDate() - 7);
      return H.todayLocalStr(d);
    })();
    const allTimeWalks = H.walkStats(entries);
    const weekWalks = H.walkStats(entries, weekAgo);

    let healthHtml = '';
    if (healthEntries.length) {
      healthHtml = `<div class="month-heading">Health</div>`;
      for (const entry of healthEntries) {
        healthHtml += await entryCardHtml(entry, today);
      }
    }

    let milestonesHtml = '';
    if (milestones.length) {
      milestonesHtml = `<div class="month-heading">Milestones &amp; favorites</div>`;
      for (const entry of milestones) {
        milestonesHtml += await entryCardHtml(entry, today);
      }
    }

    const tagsHtml = tags.length
      ? `<div class="month-heading">Tags</div>
         <div style="margin-bottom:6px;">${tags
           .map((t) => `<button type="button" class="tag-browse-chip" data-tag="${escapeHtml(t.tag)}">${escapeHtml(t.tag)} <span class="count">${t.count}</span></button>`)
           .join('')}</div>`
      : '';

    // Offer the puppy vaccination schedule suggestion only while it's
    // actually relevant — roughly the first two years.
    const showVaccineSuggestion = age && age.years < 2 && dog.birthday;

    root.innerHTML = `
      <div class="dog-hero">
        <div class="avatar-lg">${avatarUrl ? `<img src="${avatarUrl}" alt="">` : initials(dog.name)}</div>
        <h2>${escapeHtml(dog.name)}</h2>
        <div class="sub">${[dog.breed, age ? H.formatAge(age) : null].filter(Boolean).join(' · ') || 'Add breed & birthday'}</div>
      </div>
      <div class="profile-actions">
        <button class="btn btn-secondary" style="flex:1" id="editDogBtn">Edit profile</button>
        <button class="btn btn-secondary" style="flex:1" id="recapBtn">Year in review</button>
      </div>

      <div class="recap-grid" style="margin-top:18px;">
        <div class="stat-card">
          <div class="value">${weekWalks.count}</div>
          <div class="label">Walks this week</div>
          <div class="delta" style="color:var(--ink-soft)">${weekWalks.totalKm.toFixed(1)} km</div>
        </div>
        <div class="stat-card">
          <div class="value">${allTimeWalks.count}</div>
          <div class="label">Walks all-time</div>
          <div class="delta" style="color:var(--ink-soft)">${allTimeWalks.totalKm.toFixed(1)} km total</div>
        </div>
      </div>

      ${showVaccineSuggestion ? `<button class="btn btn-secondary btn-block" id="suggestVaccineBtn" style="margin-top:14px;">💉 Suggest vaccination schedule</button>` : ''}

      ${tagsHtml}
      ${healthHtml}
      ${milestonesHtml}
    `;

    wireEntryCardInteractions(root);

    $('#editDogBtn').addEventListener('click', () => {
      editingDogId = dog.id;
      $('#dogSheetTitle').textContent = 'Edit profile';
      $('#dogSheetDelete').style.display = dogs.length > 1 ? 'block' : 'none';
      $('#dogName').value = dog.name || '';
      $('#dogBreed').value = dog.breed || '';
      $('#dogBirthday').value = dog.birthday || '';
      pendingDogPhoto = null;
      dogPhotoRemoved = false;
      renderDogAvatarPicker(avatarUrl);
      openSheet($('#dogSheet'));
    });

    $('#recapBtn').addEventListener('click', () => openRecapSheet(dog.id));

    $$('.tag-browse-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        timelineQuery = chip.dataset.tag;
        timelineTypeFilter = 'all';
        $('#timelineSearch').value = chip.dataset.tag;
        $$('.filter-chip').forEach((c) => c.classList.toggle('active', c.dataset.type === 'all'));
        setTab('timeline');
      });
    });

    const suggestBtn = $('#suggestVaccineBtn');
    if (suggestBtn) suggestBtn.addEventListener('click', () => openVaccineScheduleSheet(dog));
  }

  // ================= Year in review =================

  async function openRecapSheet(dogId) {
    recapDogId = dogId;
    const entries = await Entries.forDog(dogId);
    const weights = await Weights.forDog(dogId);
    const years = H.yearsWithData(entries, weights, H.todayLocalStr());

    const select = $('#recapYearSelect');
    select.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join('');
    select.value = String(years[0]);

    renderRecapContent(entries, weights, years[0]);
    openSheet($('#recapSheet'));
  }

  function renderRecapContent(entries, weights, year) {
    const recap = H.buildYearRecap(entries, weights, year);
    const content = $('#recapContent');

    if (!recap.totalEntries && !recap.weight.first) {
      content.innerHTML = emptyStateHtml('📅', 'Nothing logged', `No entries or weigh-ins found for ${year}.`);
      return;
    }

    const weightHtml = recap.weight.first
      ? `<div class="recap-section">
          <h4>Weight</h4>
          <p style="font-size:14px;">
            ${recap.weight.first.weightKg.toFixed(1)} kg → ${recap.weight.last.weightKg.toFixed(1)} kg
            ${recap.weight.change !== null ? `<strong style="color:${recap.weight.change > 0 ? 'var(--rust)' : 'var(--moss)'}">(${recap.weight.change > 0 ? '+' : ''}${recap.weight.change.toFixed(1)} kg)</strong>` : ''}
          </p>
        </div>`
      : '';

    const typeBreakdown = Object.entries(recap.byType)
      .map(([type, count]) => `<li>${(TYPE_META[type] || {}).icon || ''} ${count} ${(TYPE_META[type] || { label: type }).label.toLowerCase()}${count === 1 ? '' : 's'}</li>`)
      .join('');

    content.innerHTML = `
      <div class="recap-hero">
        <div class="big-num">${recap.totalEntries}</div>
        <div class="big-label">entries logged in ${year}</div>
      </div>
      <div class="recap-grid">
        <div class="stat-card">
          <div class="value">${recap.walks.count}</div>
          <div class="label">Walks</div>
          <div class="delta" style="color:var(--ink-soft)">${recap.walks.totalKm.toFixed(1)} km</div>
        </div>
        <div class="stat-card">
          <div class="value">${recap.favorites.length}</div>
          <div class="label">Favorites</div>
        </div>
      </div>
      ${weightHtml}
      <div class="recap-section">
        <h4>By type</h4>
        ${typeBreakdown ? `<ul style="padding-left:18px; font-size:14px; margin:0;">${typeBreakdown}</ul>` : `<p class="empty-note">Nothing logged.</p>`}
      </div>
      ${recap.milestones.length ? `<div class="recap-section"><h4>Milestones (${recap.milestones.length})</h4><p style="font-size:14px;">${recap.milestones.map((m) => escapeHtml(m.caption || 'Milestone')).join(' · ')}</p></div>` : ''}
    `;
  }

  // ================= Dog sheet (add/edit) =================

  function resetDogForm() {
    $('#dogName').value = '';
    $('#dogBreed').value = '';
    $('#dogBirthday').value = '';
    pendingDogPhoto = null;
    dogPhotoRemoved = false;
    renderDogAvatarPicker('');
  }

  function renderDogAvatarPicker(existingUrl) {
    const wrap = $('#dogAvatarPicker');
    wrap.innerHTML = '';

    const showUrl = pendingDogPhoto ? pendingDogPhoto.previewUrl : dogPhotoRemoved ? '' : existingUrl;

    if (showUrl) {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.innerHTML = `<img src="${showUrl}" alt=""><button class="remove" type="button">×</button>`;
      thumb.querySelector('.remove').addEventListener('click', () => {
        if (pendingDogPhoto) {
          URL.revokeObjectURL(pendingDogPhoto.previewUrl);
          pendingDogPhoto = null;
        }
        dogPhotoRemoved = true;
        renderDogAvatarPicker(existingUrl);
      });
      wrap.appendChild(thumb);
    } else {
      const addBtn = document.createElement('button');
      addBtn.className = 'add-photo';
      addBtn.type = 'button';
      addBtn.textContent = '+';
      // iOS requires the file input open synchronously within the tap handler.
      addBtn.addEventListener('click', () => $('#dogPhotoInput').click());
      wrap.appendChild(addBtn);
    }
  }

  async function handleDogPhotoSelection(fileList) {
    const file = (fileList || [])[0];
    if (!file) return;
    if (!looksLikeImageFile(file)) {
      showToast("Couldn't read that photo");
      return;
    }
    showToast('Processing photo…');
    try {
      const { thumbBlob, fullBlob } = await window.Media.processPhoto(file);
      if (pendingDogPhoto) URL.revokeObjectURL(pendingDogPhoto.previewUrl);
      pendingDogPhoto = { thumbBlob, fullBlob, previewUrl: objectUrlFor(thumbBlob) };
      dogPhotoRemoved = false;
    } catch (err) {
      console.error('Dog photo processing failed', err);
      showToast(describeError(err));
      return;
    }
    renderDogAvatarPicker('');
  }

  async function saveDog() {
    const name = $('#dogName').value.trim();
    if (!name) {
      showToast('Give your dog a name first');
      return;
    }
    const breed = $('#dogBreed').value.trim();
    const birthday = $('#dogBirthday').value || null;

    let coverPhotoId;
    if (pendingDogPhoto) {
      const rec = await Photos.add({ thumbBlob: pendingDogPhoto.thumbBlob, fullBlob: pendingDogPhoto.fullBlob });
      coverPhotoId = rec.id;
    } else if (dogPhotoRemoved) {
      coverPhotoId = null;
    }

    if (editingDogId) {
      const dog = dogs.find((d) => d.id === editingDogId);
      dog.name = name;
      dog.breed = breed;
      dog.birthday = birthday;
      if (coverPhotoId !== undefined) {
        photoUrlCache.delete(dog.coverPhotoId);
        dog.coverPhotoId = coverPhotoId;
      }
      await Dogs.update(dog);
    } else {
      const dog = await Dogs.add({ name, breed, birthday, coverPhotoId: coverPhotoId || null });
      dogs.push(dog);
      currentDogId = dog.id;
      persistCurrentDog();
    }

    closeSheet($('#dogSheet'));
    await renderDogSwitcher();
    setTab(activeTab === 'profile' || dogs.length === 1 ? 'timeline' : activeTab);
    showToast('Saved');
  }

  async function deleteDog() {
    if (!editingDogId) return;
    if (!confirm("Delete this dog and all their entries? This can't be undone.")) return;

    const entries = await Entries.forDog(editingDogId);
    for (const e of entries) await Entries.remove(e.id);
    const weights = await Weights.forDog(editingDogId);
    for (const w of weights) await Weights.remove(w.id);
    await Dogs.remove(editingDogId);

    dogs = dogs.filter((d) => d.id !== editingDogId);
    if (currentDogId === editingDogId) currentDogId = dogs.length ? dogs[0].id : null;
    persistCurrentDog();
    closeSheet($('#dogSheet'));

    if (!dogs.length) {
      showOnboarding();
    } else {
      await renderDogSwitcher();
      setTab('timeline');
    }
  }

  // ================= Entry sheet (add) =================

  function updateTypeOnlyFields(type) {
    $$('.type-only').forEach((el) => {
      el.classList.toggle('hidden', el.dataset.forType !== type);
    });
    const label = $('#captionLabel');
    const placeholders = {
      photo: 'What happened?',
      note: 'What happened?',
      milestone: 'What happened?',
      walk: 'Any notes about the walk (optional)',
      vet: 'Reason for visit / notes',
      vaccination: 'Vaccine name / notes',
    };
    $('#entryCaption').placeholder = placeholders[type] || 'What happened?';
    label.textContent = type === 'vet' ? 'Reason / notes' : type === 'vaccination' ? 'Vaccine / notes' : 'Caption / note';
  }

  function resetEntryForm() {
    editingEntryId = null;
    editingEntryOriginal = null;
    removedExistingPhotoIds = [];
    $('#entrySheetTitle').textContent = 'New entry';
    $('#saveEntryBtn').textContent = 'Add to timeline';
    $('#entrySheetDelete').classList.add('hidden');

    $('#entryDate').value = H.todayLocalStr();
    $('#entryCaption').value = '';
    $('#entryTags').value = '';
    $('#walkDistanceKm').value = '';
    $('#walkDurationMin').value = '';
    $('#vaccineNextDue').value = '';
    pendingPhotos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    pendingPhotos = [];
    pendingEntryLocation = null;
    entryDateManuallyEdited = false;
    renderPhotoPicker();
    $$('.type-toggle button').forEach((b) => b.classList.toggle('selected', b.dataset.type === 'photo'));
    $('#entrySheet').dataset.type = 'photo';
    updateTypeOnlyFields('photo');
  }

  // Opens the same sheet used for adding, pre-filled from an existing entry.
  async function openEntryEditor(entry) {
    editingEntryId = entry.id;
    editingEntryOriginal = entry;
    removedExistingPhotoIds = [];

    $('#entrySheetTitle').textContent = 'Edit entry';
    $('#saveEntryBtn').textContent = 'Save changes';
    $('#entrySheetDelete').classList.remove('hidden');

    $('#entryDate').value = entry.date;
    $('#entryCaption').value = entry.caption || '';
    $('#entryTags').value = (entry.tags || []).join(', ');
    $('#walkDistanceKm').value = entry.distanceKm || '';
    $('#walkDurationMin').value = entry.durationMin || '';
    $('#vaccineNextDue').value = entry.nextDueDate || '';
    pendingEntryLocation = entry.location || null;
    // The date is already meaningfully set from the saved entry — treat it
    // as "manually edited" so adding a new photo during this edit can't
    // silently overwrite a date the user is intentionally keeping.
    entryDateManuallyEdited = true;

    pendingPhotos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    const existingPhotoRecords = await Promise.all((entry.photoIds || []).map((id) => Photos.get(id).catch(() => null)));
    pendingPhotos = existingPhotoRecords
      .filter(Boolean)
      .map((rec) => ({ existingPhotoId: rec.id, thumbBlob: rec.thumbBlob, fullBlob: rec.fullBlob, previewUrl: objectUrlFor(rec.thumbBlob) }));
    renderPhotoPicker();

    $$('.type-toggle button').forEach((b) => b.classList.toggle('selected', b.dataset.type === entry.type));
    $('#entrySheet').dataset.type = entry.type;
    updateTypeOnlyFields(entry.type);

    openSheet($('#entrySheet'));
  }

  async function deleteEntry() {
    if (!editingEntryId || !editingEntryOriginal) return;
    if (!confirm("Delete this entry? This can't be undone.")) return;

    for (const id of editingEntryOriginal.photoIds || []) await Photos.remove(id);
    await Entries.remove(editingEntryId);
    entryLookupById.delete(editingEntryId);

    closeSheet($('#entrySheet'));
    showToast('Entry deleted');
    if (activeTab === 'timeline') renderTimeline();
    else if (activeTab === 'profile') renderProfile();
  }

  function renderPhotoPicker() {
    const wrap = $('#photoPicker');
    wrap.innerHTML = '';
    pendingPhotos.forEach((p, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.innerHTML = `<img src="${p.previewUrl}" alt=""><button class="remove" data-i="${i}">×</button>`;
      wrap.appendChild(thumb);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'add-photo';
    addBtn.type = 'button';
    addBtn.textContent = '+';
    addBtn.id = 'addPhotoBtn';
    wrap.appendChild(addBtn);

    addBtn.addEventListener('click', () => $('#photoInput').click());

    $$('.thumb .remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i);
        const removed = pendingPhotos[i];
        // Only revoke/drop a brand-new (not-yet-saved) photo's preview URL
        // outright. An existing, already-stored photo needs its storage
        // record cleaned up too — tracked here and actually deleted on save,
        // so cancelling the edit entirely leaves the original untouched.
        if (removed.existingPhotoId) {
          removedExistingPhotoIds.push(removed.existingPhotoId);
        } else {
          URL.revokeObjectURL(removed.previewUrl);
        }
        pendingPhotos.splice(i, 1);
        renderPhotoPicker();
      });
    });
  }

  // EXIF reading is always best-effort and must never block a photo from
  // being saved — if anything about it fails, treat it exactly like a photo
  // that simply has no EXIF data.
  async function safeParseExif(file) {
    try {
      return await window.Exif.parseExifFromFile(file);
    } catch (err) {
      console.warn('EXIF read failed, continuing without it:', err);
      return { date: null, location: null };
    }
  }

  // Some photo pickers (notably iOS's limited-access picker, in some
  // versions) hand back files with an empty or nonstandard `type`. Fall
  // back to the file extension so a real photo never gets silently dropped
  // before it even reaches the processing step.
  // Some photo pickers (notably iOS's limited-access picker, in some
  // versions/situations) hand back files with an empty `type` and a
  // filename that doesn't obviously look like an image. Previously this
  // filtered such files out entirely — which, combined with
  // `accept="image/*"` already constraining what the OS picker shows in
  // the first place, meant a whole multi-photo selection could silently
  // vanish with zero feedback. Now: only reject a file when its type is
  // explicitly set to something that is NOT an image. An unknown/empty
  // type is given the benefit of the doubt and attempted — if it genuinely
  // isn't a readable image, Media.processPhoto's own diagnostic error
  // handles that case visibly instead of a silent no-op.
  function looksLikeImageFile(file) {
    if (file.type) return file.type.startsWith('image/');
    return true;
  }

  function describeError(err) {
    if (err && err.stage) return `Couldn't read that photo (${err.stage} failed: ${err.cause ? err.cause.message : 'unknown'})`;
    if (err && err.message) return `Couldn't read that photo (${err.message})`;
    return "Couldn't read that photo — try a different one";
  }

  async function handlePhotoSelection(fileList) {
    const rawCount = (fileList || []).length;
    const files = Array.from(fileList || []).filter(looksLikeImageFile);
    if (!files.length) {
      if (rawCount > 0) showToast(`Couldn't read the selected photo${rawCount === 1 ? '' : 's'}`);
      return;
    }
    showToast('Processing photo' + (files.length > 1 ? 's' : '') + '…');
    for (const file of files) {
      try {
        const { thumbBlob, fullBlob } = await window.Media.processPhoto(file);
        pendingPhotos.push({ thumbBlob, fullBlob, previewUrl: objectUrlFor(thumbBlob) });

        const exif = await safeParseExif(file);
        // Auto-fill the date from the photo's EXIF, but only if the user
        // hasn't already typed a date themselves — never overwrite a manual edit.
        if (exif.date && !entryDateManuallyEdited) {
          $('#entryDate').value = exif.date;
        }
        // Take the first location we find across the picked photos.
        if (exif.location && !pendingEntryLocation) {
          pendingEntryLocation = exif.location;
        }
      } catch (err) {
        console.error('Photo processing failed', err);
        showToast(describeError(err));
      }
    }
    renderPhotoPicker();
  }

  async function saveEntry() {
    const type = $('#entrySheet').dataset.type || 'photo';
    const date = $('#entryDate').value || H.todayLocalStr();
    const caption = $('#entryCaption').value.trim();
    const tags = $('#entryTags').value
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const distanceKm = parseFloat($('#walkDistanceKm').value) || 0;
    const durationMin = parseFloat($('#walkDurationMin').value) || 0;
    const nextDueDate = $('#vaccineNextDue').value || null;

    if (type === 'photo' && !pendingPhotos.length && !caption) {
      showToast('Add a photo or a note first');
      return;
    }
    if ((type === 'note' || type === 'milestone' || type === 'vet') && !caption) {
      showToast('Write a note first');
      return;
    }
    if (type === 'walk' && !distanceKm && !durationMin) {
      showToast('Add a distance or duration');
      return;
    }
    if (type === 'vaccination' && !nextDueDate) {
      showToast('Set the next due date');
      return;
    }

    let photoIds = [];
    if (type === 'photo') {
      for (const p of pendingPhotos) {
        if (p.existingPhotoId) {
          photoIds.push(p.existingPhotoId);
        } else {
          const rec = await Photos.add({ thumbBlob: p.thumbBlob, fullBlob: p.fullBlob });
          photoIds.push(rec.id);
        }
      }
    } else {
      // Type isn't (or is no longer) 'photo' — any previously-attached
      // existing photos are now orphaned and should be cleaned up.
      for (const p of pendingPhotos) {
        if (p.existingPhotoId) removedExistingPhotoIds.push(p.existingPhotoId);
      }
    }

    let savedEntry;
    if (editingEntryId) {
      savedEntry = {
        id: editingEntryOriginal.id,
        dogId: editingEntryOriginal.dogId,
        favorite: editingEntryOriginal.favorite,
        createdAt: editingEntryOriginal.createdAt,
        date,
        type,
        caption,
        photoIds,
        tags,
      };
      if (type === 'photo' && pendingEntryLocation) savedEntry.location = pendingEntryLocation;
      if (type === 'walk') {
        savedEntry.distanceKm = distanceKm || undefined;
        savedEntry.durationMin = durationMin || undefined;
      }
      if (type === 'vaccination') savedEntry.nextDueDate = nextDueDate;
      await Entries.update(savedEntry);
      entryLookupById.set(savedEntry.id, savedEntry);
    } else {
      const entry = { dogId: currentDogId, date, type, caption, photoIds, tags };
      if (type === 'photo' && pendingEntryLocation) entry.location = pendingEntryLocation;
      if (type === 'walk') {
        entry.distanceKm = distanceKm || undefined;
        entry.durationMin = durationMin || undefined;
      }
      if (type === 'vaccination') entry.nextDueDate = nextDueDate;
      savedEntry = await Entries.add(entry);
      entryLookupById.set(savedEntry.id, savedEntry);
    }

    for (const id of removedExistingPhotoIds) await Photos.remove(id);

    const wasEditing = !!editingEntryId;
    closeSheet($('#entrySheet'));
    showToast(wasEditing ? 'Entry updated' : 'Added to timeline');
    if (activeTab === 'timeline') renderTimeline();
    else if (activeTab === 'profile') renderProfile();
  }

  // ================= Bulk photo import =================

  function resetBulkImportSheet() {
    bulkImportGroups = [];
    $('#bulkImportBody').classList.remove('hidden');
    $('#bulkImportProgress').classList.add('hidden');
    $('#bulkImportProgress').textContent = '';
    $('#bulkImportGroups').innerHTML = '';
    $('#bulkImportConfirmWrap').classList.add('hidden');
  }

  // Cleans up every photo already saved to IndexedDB for groups that are
  // still pending (not yet imported), so an abandoned bulk import never
  // leaves orphaned photo blobs behind.
  async function cleanupPendingBulkPhotos() {
    for (const group of bulkImportGroups) {
      if (group.skipped) continue;
      for (const id of group.photoIds) await Photos.remove(id);
    }
    bulkImportGroups = [];
  }

  async function cancelBulkImport() {
    await cleanupPendingBulkPhotos();
    closeSheet($('#bulkImportSheet'));
  }

  async function handleBulkPhotoSelection(fileList) {
    const rawCount = (fileList || []).length;
    const files = Array.from(fileList || []).filter(looksLikeImageFile);
    if (!files.length) {
      if (rawCount > 0) {
        showToast(`Couldn't read any of the ${rawCount} selected photo${rawCount === 1 ? '' : 's'}`);
      }
      return;
    }

    $('#bulkImportBody').classList.add('hidden');
    const progress = $('#bulkImportProgress');
    progress.classList.remove('hidden');

    // A flat list of processed photos before grouping — processed one at a
    // time (not in parallel) to keep memory use bounded for large batches.
    const processed = [];
    const failures = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      progress.textContent = `Processing photo ${i + 1} of ${files.length}…`;
      try {
        const { thumbBlob, fullBlob } = await window.Media.processPhoto(file);
        const exif = await safeParseExif(file);
        const rec = await Photos.add({ thumbBlob, fullBlob });
        const date = exif.date || dateFromFileTimestamp(file);
        processed.push({ photoId: rec.id, date, location: exif.location, previewUrl: objectUrlFor(thumbBlob) });
      } catch (err) {
        console.error('Bulk photo processing failed for', file.name, err);
        failures.push(file.name || `photo ${i + 1}`);
      }
    }

    progress.classList.add('hidden');
    if (failures.length) {
      showToast(`${failures.length} of ${files.length} photo${files.length === 1 ? '' : 's'} couldn't be read and were skipped`);
    }

    // Group by date.
    const byDate = new Map();
    for (const p of processed) {
      if (!byDate.has(p.date)) byDate.set(p.date, { date: p.date, photoIds: [], previewUrls: [], location: null, skipped: false });
      const group = byDate.get(p.date);
      group.photoIds.push(p.photoId);
      group.previewUrls.push(p.previewUrl);
      if (!group.location && p.location) group.location = p.location;
    }

    bulkImportGroups = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    renderBulkImportGroups();
  }

  // Photos without EXIF data fall back to the file's own last-modified
  // timestamp — usually close to capture date, and always editable below
  // before anything is actually imported.
  function dateFromFileTimestamp(file) {
    if (file.lastModified) return H.todayLocalStr(new Date(file.lastModified));
    return H.todayLocalStr();
  }

  function renderBulkImportGroups() {
    const wrap = $('#bulkImportGroups');
    wrap.innerHTML = '';

    if (!bulkImportGroups.length) {
      wrap.innerHTML = emptyStateHtml('📷', 'No photos found', 'Try choosing photos again.');
      $('#bulkImportConfirmWrap').classList.add('hidden');
      return;
    }

    bulkImportGroups.forEach((group, i) => {
      const row = document.createElement('div');
      row.className = 'import-group' + (group.skipped ? ' skipped' : '');

      const thumbsHtml =
        group.previewUrls
          .slice(0, 3)
          .map((u) => `<img src="${u}" alt="">`)
          .join('') + (group.previewUrls.length > 3 ? `<div class="more">+${group.previewUrls.length - 3}</div>` : '');

      row.innerHTML = `
        <div class="row-top">
          <input type="date" value="${group.date}" ${group.skipped ? 'disabled' : ''}>
          <button type="button" class="skip-btn">${group.skipped ? 'Include' : 'Skip'}</button>
        </div>
        <div class="thumbs">${thumbsHtml}</div>
        <div style="font-size:12px; color:var(--ink-soft); margin-top:6px;">${group.photoIds.length} photo${group.photoIds.length === 1 ? '' : 's'}${group.location ? ' · 📍 has location' : ''}</div>
      `;

      row.querySelector('input[type="date"]').addEventListener('change', (e) => {
        group.date = e.target.value || group.date;
      });
      row.querySelector('.skip-btn').addEventListener('click', () => {
        group.skipped = !group.skipped;
        renderBulkImportGroups();
      });

      wrap.appendChild(row);
    });

    const activeCount = bulkImportGroups.filter((g) => !g.skipped).length;
    const confirmWrap = $('#bulkImportConfirmWrap');
    confirmWrap.classList.toggle('hidden', activeCount === 0);
    $('#confirmBulkImportBtn').textContent = `Import ${activeCount} ${activeCount === 1 ? 'entry' : 'entries'}`;
  }

  async function confirmBulkImport() {
    const toImport = bulkImportGroups.filter((g) => !g.skipped);
    const toDiscard = bulkImportGroups.filter((g) => g.skipped);

    for (const group of toDiscard) {
      for (const id of group.photoIds) await Photos.remove(id);
    }

    for (const group of toImport) {
      const entry = { dogId: currentDogId, date: group.date, type: 'photo', caption: '', photoIds: group.photoIds, tags: [] };
      if (group.location) entry.location = group.location;
      await Entries.add(entry);
    }

    bulkImportGroups = [];
    closeSheet($('#bulkImportSheet'));
    showToast(`Imported ${toImport.length} ${toImport.length === 1 ? 'entry' : 'entries'}`);
    if (activeTab === 'timeline') renderTimeline();
  }

  // ================= Full-screen photo viewer =================

  async function getPhotoFullUrl(photoId) {
    if (fullUrlCache.has(photoId)) return fullUrlCache.get(photoId);
    const rec = await Photos.get(photoId).catch(() => null);
    const url = rec && rec.fullBlob ? objectUrlFor(rec.fullBlob) : rec && rec.thumbBlob ? objectUrlFor(rec.thumbBlob) : '';
    fullUrlCache.set(photoId, url);
    return url;
  }

  async function showPhotoViewerImage() {
    const { photoIds, index } = photoViewerContext;
    const img = $('#pvImage');
    img.style.transform = '';
    img.classList.remove('snap-back');
    img.src = await getPhotoFullUrl(photoIds[index]);
    $('#pvCounter').textContent = photoIds.length > 1 ? `${index + 1} / ${photoIds.length}` : '';
  }

  function openPhotoViewer(photoIds, startIndex) {
    if (!photoIds || !photoIds.length) return;
    photoViewerContext = { photoIds, index: Math.min(startIndex, photoIds.length - 1) };
    $('#photoViewer').classList.add('open');
    showPhotoViewerImage();
  }

  function closePhotoViewer() {
    $('#photoViewer').classList.remove('open');
    $('#pvImage').src = '';
  }

  function wirePhotoViewerSwipe() {
    const img = $('#pvImage');
    let startX = 0;
    let dragging = false;

    img.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      dragging = true;
      img.classList.remove('snap-back');
    }, { passive: true });

    img.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - startX;
      img.style.transform = `translateX(${dx}px)`;
    }, { passive: true });

    img.addEventListener('touchend', (e) => {
      if (!dragging) return;
      dragging = false;
      const dx = (e.changedTouches[0] ? e.changedTouches[0].clientX : startX) - startX;
      const threshold = 70;
      const { photoIds, index } = photoViewerContext;

      img.classList.add('snap-back');
      if (dx < -threshold && index < photoIds.length - 1) {
        photoViewerContext.index += 1;
        showPhotoViewerImage();
      } else if (dx > threshold && index > 0) {
        photoViewerContext.index -= 1;
        showPhotoViewerImage();
      } else {
        img.style.transform = 'translateX(0px)';
      }
    });
  }

  // ================= Stats dashboard =================

  async function renderStats() {
    const root = $('#screen-stats');
    const entries = await Entries.forDog(currentDogId);

    if (!entries.length) {
      root.innerHTML = emptyStateHtml('📊', 'Nothing to show yet', 'Stats will appear here once you start logging entries.');
      return;
    }

    const today = H.todayLocalStr();
    const months = H.entriesPerMonth(entries, 12, today);
    const maxCount = Math.max(1, ...months.map((m) => m.count));
    const streak = H.longestStreak(entries);
    const totalPhotos = entries.reduce((sum, e) => sum + (e.photoIds ? e.photoIds.length : 0), 0);

    const byType = {};
    for (const e of entries) byType[e.type] = (byType[e.type] || 0) + 1;
    const typeRows = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => {
        const meta = TYPE_META[type] || TYPE_META.note;
        return `<div class="weight-row"><span>${meta.icon} ${meta.label}</span><span class="w-val">${count}</span></div>`;
      })
      .join('');

    const barsHtml = months
      .map((m) => {
        const heightPct = Math.max(4, Math.round((m.count / maxCount) * 100));
        return `<div class="bar-col"><div class="bar" style="height:${heightPct}%" title="${m.count}"></div><div class="bar-label">${m.label}</div></div>`;
      })
      .join('');

    root.innerHTML = `
      <div class="recap-grid" style="margin-top:6px;">
        <div class="stat-card">
          <div class="value">${entries.length}</div>
          <div class="label">Total entries</div>
        </div>
        <div class="stat-card">
          <div class="value">${totalPhotos}</div>
          <div class="label">Photos</div>
        </div>
      </div>
      <div class="recap-grid">
        <div class="stat-card">
          <div class="value">${streak}</div>
          <div class="label">Longest streak (days)</div>
        </div>
        <div class="stat-card">
          <div class="value">${H.getAllTags(entries).length}</div>
          <div class="label">Distinct tags</div>
        </div>
      </div>
      <div class="chart-card">
        <div style="font-size:12px; color:var(--ink-soft); margin-bottom:4px;">Entries per month</div>
        <div class="bar-chart">${barsHtml}</div>
      </div>
      <div class="month-heading">By type</div>
      ${typeRows}
    `;
  }

  // ================= Puppy vaccination schedule =================

  function openVaccineScheduleSheet(dog) {
    pendingVaccineSchedule = H.puppyVaccinationSchedule(dog.birthday).map((s) => ({ ...s, skipped: false }));
    renderVaccineScheduleRows();
    openSheet($('#vaccineScheduleSheet'));
  }

  function renderVaccineScheduleRows() {
    const wrap = $('#vaccineScheduleRows');
    wrap.innerHTML = '';
    pendingVaccineSchedule.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'vaccine-row' + (item.skipped ? ' skipped' : '');
      row.innerHTML = `
        <div class="row-top">
          <span class="label">${escapeHtml(item.label)}</span>
          <button type="button" class="skip-btn">${item.skipped ? 'Include' : 'Skip'}</button>
        </div>
        <input type="date" value="${item.dueDate}" ${item.skipped ? 'disabled' : ''}>
      `;
      row.querySelector('input[type="date"]').addEventListener('change', (e) => {
        item.dueDate = e.target.value || item.dueDate;
      });
      row.querySelector('.skip-btn').addEventListener('click', () => {
        item.skipped = !item.skipped;
        renderVaccineScheduleRows();
      });
      wrap.appendChild(row);
    });
  }

  async function confirmVaccineSchedule() {
    const today = H.todayLocalStr();
    const toAdd = pendingVaccineSchedule.filter((s) => !s.skipped);
    for (const item of toAdd) {
      const entry = await Entries.add({
        dogId: currentDogId,
        date: today,
        type: 'vaccination',
        caption: item.label,
        photoIds: [],
        tags: [],
        nextDueDate: item.dueDate,
      });
      entryLookupById.set(entry.id, entry);
    }
    pendingVaccineSchedule = [];
    closeSheet($('#vaccineScheduleSheet'));
    showToast(`Added ${toAdd.length} reminder${toAdd.length === 1 ? '' : 's'}`);
    if (activeTab === 'profile') renderProfile();
    else if (activeTab === 'timeline') renderTimeline();
  }

  // ================= Theme =================

  function resolveTheme(mode) {
    if (mode === 'dark' || mode === 'light') return mode;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  }

  function setThemePreference(mode) {
    localStorage.setItem('pawbook_theme', mode);
    applyTheme(mode);
  }

  function getThemePreference() {
    return localStorage.getItem('pawbook_theme') || 'system';
  }

  // ================= Backup screen =================

  function renderBackupScreen() {
    const root = $('#screen-backup');
    const currentPref = getThemePreference();
    root.innerHTML = `
      <div class="backup-card">
        <h3>Display</h3>
        <div class="type-toggle" id="themeToggle" style="grid-template-columns: repeat(3, 1fr);">
          <button type="button" data-mode="system" class="${currentPref === 'system' ? 'selected' : ''}">System</button>
          <button type="button" data-mode="light" class="${currentPref === 'light' ? 'selected' : ''}">Light</button>
          <button type="button" data-mode="dark" class="${currentPref === 'dark' ? 'selected' : ''}">Dark</button>
        </div>
      </div>
      <div class="backup-card">
        <h3>Export backup</h3>
        <p>Saves everything — every dog, entry, photo, and weigh-in — to a single file you keep yourself (Files app, iCloud Drive, email to yourself, wherever). Since PawBook stores data only on this device, this is the only way it survives a lost or replaced phone.</p>
        <button class="btn btn-primary btn-block" id="exportBtn">Export backup</button>
        <div class="backup-status" id="exportStatus"></div>
      </div>
      <div class="backup-card">
        <h3>Restore from backup</h3>
        <p>Choose a previously exported backup file. Restoring is safe to repeat — it won't create duplicates, even if you import the same file twice.</p>
        <button class="btn btn-secondary btn-block" id="importBtn">Choose backup file…</button>
        <input type="file" id="importInput" accept="application/json" style="display:none;">
        <div class="backup-status" id="importStatus"></div>
      </div>
    `;

    $$('#themeToggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        setThemePreference(btn.dataset.mode);
        $$('#themeToggle button').forEach((b) => b.classList.toggle('selected', b === btn));
      });
    });

    $('#exportBtn').addEventListener('click', async () => {
      const status = $('#exportStatus');
      status.classList.remove('error');
      status.textContent = 'Preparing export…';
      try {
        const summary = await window.Backup.exportBackup();
        status.textContent = `Exported ${summary.dogCount} dog(s), ${summary.entryCount} entries, ${summary.weightCount} weigh-ins, ${summary.photoCount} photos.`;
      } catch (err) {
        console.error('Export failed', err);
        status.classList.add('error');
        status.textContent = 'Export failed — please try again.';
      }
    });

    $('#importBtn').addEventListener('click', () => $('#importInput').click());

    $('#importInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const status = $('#importStatus');
      status.classList.remove('error');
      status.textContent = 'Restoring…';
      try {
        const payload = await window.Backup.readBackupFile(file);
        const summary = await window.Backup.restoreBackup(payload);
        status.textContent = `Restored ${summary.dogCount} dog(s), ${summary.entryCount} entries, ${summary.weightCount} weigh-ins, ${summary.photoCount} photos.`;
        photoUrlCache.clear();
        dogs = await Dogs.all();
        if (!dogs.some((d) => d.id === currentDogId)) currentDogId = dogs[0] ? dogs[0].id : null;
        persistCurrentDog();
        await renderDogSwitcher();
        showToast('Backup restored');
      } catch (err) {
        console.error('Restore failed', err);
        status.classList.add('error');
        status.textContent = err.message || 'That file could not be restored.';
      }
    });
  }

  // ================= Wire events =================

  let wired = false;
  function wireEvents() {
    if (wired) return;
    wired = true;

    tabBtns.forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));

    fab.addEventListener('click', () => {
      resetEntryForm();
      openSheet($('#entrySheet'));
    });

    $$('.type-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.type-toggle button').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        $('#entrySheet').dataset.type = btn.dataset.type;
        updateTypeOnlyFields(btn.dataset.type);
      });
    });

    $('#photoInput').addEventListener('change', (e) => {
      handlePhotoSelection(e.target.files);
      e.target.value = '';
    });

    $('#entryDate').addEventListener('input', () => {
      // Only real user typing fires 'input'; our own auto-fill sets .value
      // directly, which does not — so this cleanly distinguishes the two.
      entryDateManuallyEdited = true;
    });

    $('#dogPhotoInput').addEventListener('change', (e) => {
      handleDogPhotoSelection(e.target.files);
      e.target.value = '';
    });

    $('#openBulkImportBtn').addEventListener('click', () => {
      resetBulkImportSheet();
      openSheet($('#bulkImportSheet'));
    });
    $('#chooseBulkPhotosBtn').addEventListener('click', () => $('#bulkPhotoInput').click());
    $('#bulkPhotoInput').addEventListener('change', (e) => {
      handleBulkPhotoSelection(e.target.files);
      e.target.value = '';
    });
    $('#confirmBulkImportBtn').addEventListener('click', confirmBulkImport);
    $('#cancelBulkImportBtn').addEventListener('click', cancelBulkImport);

    $('#sheetBackdrop').addEventListener('click', closeAllSheets);
    $$('.sheet-close').forEach((btn) => btn.addEventListener('click', () => closeSheet(btn.closest('.sheet'))));

    $('#saveEntryBtn').addEventListener('click', saveEntry);
    $('#saveDogBtn').addEventListener('click', saveDog);
    $('#dogSheetDelete').addEventListener('click', deleteDog);
    $('#saveWeightBtn').addEventListener('click', async () => {
      const date = $('#weightDate').value || H.todayLocalStr();
      const kg = parseFloat($('#weightKg').value);
      if (!kg || kg <= 0) {
        showToast('Enter a valid weight');
        return;
      }
      await Weights.add({ dogId: currentDogId, date, weightKg: kg, note: $('#weightNote').value.trim() });
      closeSheet($('#weightSheet'));
      showToast('Weight logged');
      if (activeTab === 'weight') renderWeight();
    });

    // Timeline search — debounced, and only re-renders #timelineContent, so
    // the search input (which lives outside that container) never loses focus.
    let searchDebounce;
    $('#timelineSearch').addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        timelineQuery = e.target.value;
        if (activeTab === 'timeline') renderTimeline();
      }, 150);
    });

    $$('.filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        $$('.filter-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        timelineTypeFilter = chip.dataset.type;
        if (activeTab === 'timeline') renderTimeline();
      });
    });

    $('#recapYearSelect').addEventListener('change', async (e) => {
      const entries = await Entries.forDog(recapDogId);
      const weights = await Weights.forDog(recapDogId);
      renderRecapContent(entries, weights, Number(e.target.value));
    });

    $('#entrySheetDelete').addEventListener('click', deleteEntry);

    $('#pvCloseBtn').addEventListener('click', closePhotoViewer);
    $('#pvStage').addEventListener('click', (e) => {
      if (e.target.id === 'pvStage') closePhotoViewer();
    });
    wirePhotoViewerSwipe();

    $('#confirmVaccineScheduleBtn').addEventListener('click', confirmVaccineSchedule);
  }

  // ================= Theme boot =================

  applyTheme(getThemePreference());
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getThemePreference() === 'system') applyTheme('system');
    });
  }

  // ================= Service worker =================

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch((err) => {
        console.warn('Service worker registration failed', err);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
