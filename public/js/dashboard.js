const API = '';
let allSubmissions = [];
let currentFilter = 'all';
let sortField = 'student_id'; // default sort by student ID
let sortOrder = 'asc';

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  loadModel();
  loadData();
  loadRosterStatus();
  setupEventListeners();
  setupSSE();
  setupLogPanel();
});

function setupEventListeners() {
  document.getElementById('btn-scan').addEventListener('click', scanSubmissions);
  document.getElementById('btn-sync-roster').addEventListener('click', syncRoster);
  document.getElementById('btn-batch-grade').addEventListener('click', batchGrade);
  document.getElementById('btn-export').addEventListener('click', exportGrades);

  document.getElementById('filter-tabs').addEventListener('click', (e) => {
    if (e.target.classList.contains('filter-tab')) {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      currentFilter = e.target.dataset.filter;
      renderTable();
    }
  });

  // Model selector
  document.getElementById('model-select').addEventListener('change', async (e) => {
    try {
      const res = await fetch(`${API}/api/model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: e.target.value }),
      });
      if (!res.ok) throw new Error('Failed');
      showToast(`模型已切换为 ${e.target.value}`, 'success');
    } catch (err) {
      showToast('模型切换失败', 'error');
    }
  });

  // Roster file upload
  document.getElementById('roster-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${API}/api/import-roster`, { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        showToast(`花名册导入成功：${data.imported} 名学生`, 'success');
        loadRosterStatus();
      } else {
        showToast('导入失败: ' + data.error, 'error');
      }
    } catch (err) {
      showToast('导入失败: ' + err.message, 'error');
    }
    e.target.value = '';
  });

  // PDF file upload via button
  document.getElementById('pdf-upload').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files).filter(f => f.type === 'application/pdf');
    if (files.length === 0) return;
    await uploadPdfs(files);
    e.target.value = '';
  });

  // Drag and drop
  const dropZone = document.getElementById('drop-zone');
  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) dropZone.classList.add('active');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropZone.classList.remove('active');
    }
  });

  document.addEventListener('dragover', (e) => e.preventDefault());

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropZone.classList.remove('active');

    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );
    if (files.length === 0) {
      showToast('请拖放 PDF 文件', 'error');
      return;
    }
    await uploadPdfs(files);
  });

  // Table header sorting
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (sortField === field) {
        sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
      } else {
        sortField = field;
        sortOrder = 'asc';
      }
      renderTable();
    });
  });
}

// ── Upload PDFs ──
async function uploadPdfs(files) {
  showToast(`正在上传 ${files.length} 个 PDF 文件...`, 'info');

  const formData = new FormData();
  for (const f of files) {
    formData.append('pdfs', f);
  }
  formData.append('assignment', 'midterm');

  try {
    const res = await fetch(`${API}/api/upload-pdfs`, { method: 'POST', body: formData });
    const data = await res.json();
    if (res.ok) {
      const skipped = data.results?.filter(r => r.status === 'skipped').length || 0;
      let msg = `上传完成：${data.imported} 个文件已导入`;
      if (skipped > 0) msg += `，${skipped} 个已跳过（重复）`;
      showToast(msg, 'success');
      loadData();
    } else {
      showToast('上传失败: ' + data.error, 'error');
    }
  } catch (err) {
    showToast('上传失败: ' + err.message, 'error');
  }
}

// ── Load Model Config ──
async function loadModel() {
  try {
    const res = await fetch(`${API}/api/model`);
    const data = await res.json();
    const select = document.getElementById('model-select');
    select.innerHTML = '';
    for (const [id, info] of Object.entries(data.models)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = info.label;
      if (id === data.current) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error('Failed to load model config:', err);
  }
}

// ── Load Roster Status ──
async function loadRosterStatus() {
  try {
    const res = await fetch(`${API}/api/students`);
    const students = await res.json();
    const el = document.getElementById('roster-info');
    if (students.length > 0) {
      el.className = 'roster-info loaded';
      el.textContent = `✅ 花名册已加载 (${students.length} 人)`;
    } else {
      el.className = 'roster-info';
      el.textContent = '📋 未导入花名册';
    }
  } catch (err) {
    console.error('Failed to load roster:', err);
  }
}

async function loadData() {
  try {
    const [subsRes, statsRes] = await Promise.all([
      fetch(`${API}/api/submissions?assignment=midterm`),
      fetch(`${API}/api/stats?assignment=midterm`),
    ]);
    allSubmissions = await subsRes.json();
    const stats = await statsRes.json();
    renderStats(stats);
    renderProgress(stats);
    renderTable();
  } catch (err) {
    showToast('加载失败: ' + err.message, 'error');
  }
}

// ── Render Stats ──
function renderStats(stats) {
  document.getElementById('stat-total').textContent = stats.total;
  const aiGraded = (stats.byStatus.ai_graded || 0) + (stats.byStatus.reviewed || 0) + (stats.byStatus.finalized || 0);
  document.getElementById('stat-graded').textContent = aiGraded;
  document.getElementById('stat-reviewed').textContent = (stats.byStatus.reviewed || 0) + (stats.byStatus.finalized || 0);
  document.getElementById('stat-finalized').textContent = stats.byStatus.finalized || 0;
  document.getElementById('stat-avg').textContent = stats.total > 0 && stats.avgScore ? stats.avgScore : '—';
  document.getElementById('stat-median').textContent = stats.total > 0 && stats.medianScore ? stats.medianScore : '—';
}

// ── Render Progress ──
function renderProgress(stats) {
  const total = stats.total || 1;
  const bar = document.getElementById('progress-bar');
  const segments = [
    { cls: 'finalized', count: stats.byStatus.finalized || 0 },
    { cls: 'reviewed', count: stats.byStatus.reviewed || 0 },
    { cls: 'ai-graded', count: stats.byStatus.ai_graded || 0 },
    { cls: 'grading', count: stats.byStatus.grading || 0 },
  ];
  bar.innerHTML = segments.map(s =>
    `<div class="progress-segment ${s.cls}" style="width: ${(s.count / total) * 100}%"></div>`
  ).join('');
}

// ── Render Table ──
function renderTable() {
  const filtered = currentFilter === 'all'
    ? allSubmissions
    : allSubmissions.filter(s => s.status === currentFilter);

  // Apply sorting
  let sorted = [...filtered];
  if (sortField) {
    sorted.sort((a, b) => {
      let valA = '';
      let valB = '';

      if (sortField === 'index') {
        valA = a.id;
        valB = b.id;
      } else if (sortField === 'student_id') {
        valA = a.student_id || '';
        valB = b.student_id || '';
      } else if (sortField === 'student_name') {
        valA = a.student_name || '';
        valB = b.student_name || '';
      } else if (sortField === 'status') {
        valA = a.status || '';
        valB = b.status || '';
      } else if (sortField === 'ai_score') {
        const scoreA = a.ai_grade_json ? JSON.parse(a.ai_grade_json).total_score : -1;
        const scoreB = b.ai_grade_json ? JSON.parse(b.ai_grade_json).total_score : -1;
        return sortOrder === 'asc' ? scoreA - scoreB : scoreB - scoreA;
      } else if (sortField === 'final_score') {
        const scoreA = a.total_score ?? -1;
        const scoreB = b.total_score ?? -1;
        return sortOrder === 'asc' ? scoreA - scoreB : scoreB - scoreA;
      } else if (sortField === 'graded_by') {
        valA = a.graded_by || '';
        valB = b.graded_by || '';
      }

      // Chinese Pinyin sorting
      if (sortField === 'student_name') {
        return sortOrder === 'asc'
          ? valA.localeCompare(valB, 'zh')
          : valB.localeCompare(valA, 'zh');
      }

      if (valA === valB) return 0;

      if (typeof valA === 'string' && typeof valB === 'string') {
        return sortOrder === 'asc'
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);
      } else {
        return sortOrder === 'asc'
          ? (valA > valB ? 1 : -1)
          : (valB > valA ? 1 : -1);
      }
    });
  }

  // Update header sort icons in real-time
  document.querySelectorAll('th[data-sort]').forEach(th => {
    const field = th.dataset.sort;
    const iconSpan = th.querySelector('.sort-icon');
    if (iconSpan) {
      if (field === sortField) {
        iconSpan.textContent = sortOrder === 'asc' ? ' ▲' : ' ▼';
        iconSpan.style.color = 'var(--accent)';
      } else {
        iconSpan.textContent = '';
      }
    }
  });

  const tbody = document.getElementById('submissions-body');
  const empty = document.getElementById('empty-state');

  if (sorted.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = allSubmissions.length === 0 ? 'block' : 'block';
    return;
  }

  empty.style.display = 'none';

  tbody.innerHTML = sorted.map((sub, i) => {
    const aiScore = sub.ai_grade_json ? JSON.parse(sub.ai_grade_json).total_score : '—';
    const finalScore = sub.total_score ?? '—';
    const statusLabel = {
      pending: '待处理', grading: '批改中', ai_graded: 'AI 已评',
      reviewed: '已确认', finalized: '已锁定', error: '出错'
    }[sub.status] || sub.status;

    // Dim temp IDs or nulls that are unidentified
    const studentIdDisplay = (!sub.student_id || sub.student_id.startsWith('_scan_'))
      ? `<span style="color:var(--text-muted);font-style:italic;">待识别</span>`
      : sub.student_id;

    return `<tr>
      <td>${i + 1}</td>
      <td class="mono" id="sid-${sub.id}">${studentIdDisplay}</td>
      <td id="sname-${sub.id}">${sub.student_name || '—'}</td>
      <td><span class="badge badge-${sub.status}">${statusLabel}</span></td>
      <td class="mono">${aiScore}</td>
      <td class="mono" style="font-weight:600">${finalScore}</td>
      <td>${sub.graded_by || ''}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm" style="opacity:0.6" onclick="editIdentity(${sub.id},'${(sub.student_id||'').replace(/'/g,"\\'")}','${(sub.student_name||'').replace(/'/g,"\\'")}')">✏️</button>
          ${sub.status === 'pending' || sub.status === 'error'
            ? `<button class="btn btn-sm btn-primary" onclick="aiGrade(${sub.id}, this)">🤖 AI 批改</button>`
            : `<button class="btn btn-sm btn-secondary" onclick="aiGrade(${sub.id}, this)">🔄 重评</button>`}
          ${sub.status !== 'pending'
            ? `<a href="/grade/${sub.id}" class="btn btn-sm btn-secondary">📝 查看</a>`
            : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Actions ──

async function scanSubmissions() {
  try {
    const res = await fetch(`${API}/api/scan-submissions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignment: 'midterm' }),
    });
    const data = await res.json();
    showToast(`扫描完成：发现 ${data.total} 个 PDF，新导入 ${data.imported} 个`, 'success');
    loadData();
  } catch (err) {
    showToast('扫描失败: ' + err.message, 'error');
  }
}

async function syncRoster() {
  showToast('正在与花名册同步...', 'info');
  try {
    const res = await fetch(`${API}/api/sync-roster`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignment: 'midterm' }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`同步完成：匹配并更新了 ${data.updated} 份卷子`, 'success');
      loadData();
    } else {
      showToast('同步失败: ' + data.error, 'error');
    }
  } catch (err) {
    showToast('同步失败: ' + err.message, 'error');
  }
}

async function batchGrade() {
  const pending = allSubmissions.filter(s => s.status === 'pending' || s.status === 'error');
  if (pending.length === 0) {
    showToast('没有待处理的卷子', 'info');
    return;
  }

  if (!confirm(`确认开始批量 AI 批改 ${pending.length} 份卷子？`)) return;

  document.getElementById('btn-batch-grade').disabled = true;
  showToast(`正在批改 ${pending.length} 份卷子，请勿关闭页面...`, 'info');

  try {
    await fetch(`${API}/api/submissions/batch-grade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignment: 'midterm' }),
    });
    showToast('批量批改已启动，自动刷新中...', 'success');
    // Poll for updates
    const interval = setInterval(async () => {
      await loadData();
      const stillGrading = allSubmissions.some(s => s.status === 'grading');
      if (!stillGrading) {
        clearInterval(interval);
        document.getElementById('btn-batch-grade').disabled = false;
        showToast('批量批改完成！', 'success');
      }
    }, 5000);
  } catch (err) {
    showToast('批量批改失败: ' + err.message, 'error');
    document.getElementById('btn-batch-grade').disabled = false;
  }
}

window.aiGrade = async function(id, btn) {
  const sub = allSubmissions.find(s => s.id === id);
  if (sub && sub.status !== 'pending' && sub.status !== 'error') {
    const label = sub.student_name || sub.student_id || '未命名学生';
    if (!confirm(`确认要重新批改 [${label}] 的整份卷子吗？\n警告：这将会覆盖当前已有的评分和修改理由！`)) {
      return;
    }
  }

  let originalHtml = '';
  if (btn) {
    btn.disabled = true;
    originalHtml = btn.innerHTML;
    btn.innerHTML = `<span class="spinner-sm" style="margin-right:4px; vertical-align:middle;"></span>⏳ 批改中...`;
  }

  showToast('正在 AI 批改...', 'info');
  try {
    const res = await fetch(`${API}/api/submissions/${id}/ai-grade`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }
    const data = await res.json();
    showToast(`AI 批改完成！(${data.model})`, 'success');
    loadData();
  } catch (err) {
    showToast('AI 批改失败: ' + err.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
    loadData();
  }
};

// ── Edit Student Identity ──
window.editIdentity = function(id, currentSid, currentName) {
  const newSid = prompt('学号:', currentSid || '');
  if (newSid === null) return;
  const newName = prompt('姓名:', currentName || '');
  if (newName === null) return;

  if (!newSid.trim() || !newName.trim()) {
    showToast('学号和姓名不能为空', 'error');
    return;
  }

  fetch(`${API}/api/submissions/${id}/identity`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ student_id: newSid.trim(), student_name: newName.trim() }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.error) throw new Error(data.error);
      showToast(`已更新: ${newSid} / ${newName}`, 'success');
      loadData();
    })
    .catch(err => showToast('更新失败: ' + err.message, 'error'));
};

function exportGrades() {
  window.open(`${API}/api/export?assignment=midterm`);
}

// ── Toast ──
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ── SSE Event Stream ──
let isGrading = false;
let isReplayingHistory = false;

function setupSSE() {
  const es = new EventSource(`${API}/api/events`);
  isReplayingHistory = true;
  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === 'connected') {
      isReplayingHistory = false;
      return;
    }
    handleGradingEvent(event);
  };
  es.onerror = () => {};
}

function handleGradingEvent(event) {
  switch (event.type) {
    case 'batch_start':
      isGrading = true;
      addLogEntry('start', `📦 批量批改启动 — ${event.count} 份卷子，模型: ${event.model}`, event.time);
      break;

    case 'grading_start':
      isGrading = true;
      updateLogHeader(true);
      const progress = event.progress ? `[${event.progress}] ` : '';
      addLogEntry('start', `${progress}⏳ 正在批改: ${event.label} (${event.model})`, event.time);
      break;

    case 'grading_done':
      addLogEntry('done', `${event.progress ? `[${event.progress}] ` : ''}✅ ${event.label} — ${event.score}/120`, event.time);
      if (!event.progress) {
        isGrading = false;
        updateLogHeader(false);
      }
      if (!isReplayingHistory) loadData();
      break;

    case 'grading_error':
      addLogEntry('error', `${event.progress ? `[${event.progress}] ` : ''}❌ ${event.label} — ${event.error}`, event.time);
      if (!event.progress) {
        isGrading = false;
        updateLogHeader(false);
      }
      if (!isReplayingHistory) loadData();
      break;

    case 'batch_done':
      isGrading = false;
      addLogEntry('done', `🎉 批量批改完成！共 ${event.count} 份`, event.time);
      updateLogHeader(false);
      document.getElementById('btn-batch-grade').disabled = false;
      if (!isReplayingHistory) loadData();
      break;

    case 'retry':
      addLogEntry('start', `${event.progress ? `[${event.progress}] ` : ''}🔄 ${event.label} — 第${event.attempt}/${event.max}次重试 (${event.reason})`, event.time);
      break;
  }
}

// ── Log Panel (persistent, minimizable) ──
let logMinimized = localStorage.getItem('logMinimized') === 'true';

function setupLogPanel() {
  const panel = document.getElementById('log-panel');
  const toggleBtn = document.getElementById('log-toggle');
  const indicator = document.getElementById('log-indicator');

  // Always show panel
  panel.classList.add('visible');
  applyLogBodyClass();

  toggleBtn.addEventListener('click', () => {
    logMinimized = !logMinimized;
    panel.classList.toggle('minimized', logMinimized);
    localStorage.setItem('logMinimized', logMinimized);
    toggleBtn.textContent = logMinimized ? '▶' : '◀';
    applyLogBodyClass();
  });

  indicator.addEventListener('click', () => {
    logMinimized = false;
    panel.classList.remove('minimized');
    localStorage.setItem('logMinimized', 'false');
    toggleBtn.textContent = '◀';
    indicator.classList.remove('visible');
    applyLogBodyClass();
  });
}

function applyLogBodyClass() {
  document.body.classList.toggle('log-open', !logMinimized);
  document.body.classList.toggle('log-minimized', logMinimized);
}

function updateLogHeader(active) {
  const header = document.querySelector('.log-panel-header h3');
  if (active) {
    header.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> AI 批改日志';
    if (logMinimized) document.getElementById('log-indicator').classList.add('visible');
  } else {
    header.innerHTML = '📋 AI 批改日志';
    document.getElementById('log-indicator').classList.remove('visible');
  }
}

function addLogEntry(cls, msg, time) {
  const body = document.getElementById('log-body');
  const entry = document.createElement('div');
  entry.className = `log-entry ${cls}`;
  entry.innerHTML = `<span class="log-time">${time || new Date().toLocaleTimeString('zh-CN')}</span><span class="log-msg">${msg}</span>`;
  body.appendChild(entry);
  body.scrollTop = body.scrollHeight;
}

