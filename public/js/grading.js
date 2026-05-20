// ── Grading View Logic ──

const API = '';
const submissionId = Number(window.location.pathname.split('/').pop());
const activeAssignment = localStorage.getItem('active_assignment') || 'default';
let submission = null;
let allSubmissions = [];
let currentGrade = null; // The grade being edited (AI or final)

// ── PDF.js ──
let pdfDoc = null;
let pageNum = 1;
let pageRendering = false;
let scale = 1.2;

async function initPdfViewer(url) {
  const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs';

  const loadingTask = pdfjsLib.getDocument(url);
  pdfDoc = await loadingTask.promise;
  document.getElementById('pdf-page-info').textContent = `1 / ${pdfDoc.numPages}`;
  renderPage(1);
}

async function renderPage(num) {
  if (pageRendering) return;
  pageRendering = true;

  const page = await pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale });
  const canvas = document.getElementById('pdf-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvasContext: ctx, viewport }).promise;
  pageNum = num;
  document.getElementById('pdf-page-info').textContent = `${num} / ${pdfDoc.numPages}`;
  pageRendering = false;
}

document.getElementById('pdf-prev').addEventListener('click', () => {
  if (pageNum > 1) renderPage(pageNum - 1);
});
document.getElementById('pdf-next').addEventListener('click', () => {
  if (pdfDoc && pageNum < pdfDoc.numPages) renderPage(pageNum + 1);
});
document.getElementById('pdf-zoom-in').addEventListener('click', () => {
  scale = Math.min(scale + 0.2, 3.0);
  document.getElementById('pdf-zoom-level').textContent = Math.round((scale / 1.2) * 100) + '%';
  renderPage(pageNum);
});
document.getElementById('pdf-zoom-out').addEventListener('click', () => {
  scale = Math.max(scale - 0.2, 0.4);
  document.getElementById('pdf-zoom-level').textContent = Math.round((scale / 1.2) * 100) + '%';
  renderPage(pageNum);
});

// ── Load Submission ──

async function loadSubmission() {
  try {
    // Load all submissions for navigation
    const allRes = await fetch(`${API}/api/submissions?assignment=${activeAssignment}`);
    allSubmissions = await allRes.json();

    // Load this submission
    const res = await fetch(`${API}/api/submissions/${submissionId}`);
    if (!res.ok) throw new Error('Submission not found');
    submission = await res.json();

    // Set header
    document.getElementById('nav-student').textContent =
      `${submission.student_name || '未知'} (${submission.student_id || '—'})`;

    const idx = allSubmissions.findIndex(s => s.id === submissionId);
    document.getElementById('nav-index').textContent = `${idx + 1} / ${allSubmissions.length}`;

    // Load PDF
    initPdfViewer(`${API}/api/submissions/${submissionId}/pdf`);

    // Load grade
    currentGrade = submission.final_grade || submission.ai_grade || null;
    renderScorePanel();

    // Load chat
    loadChat();

    // Setup navigation
    setupNav(idx);
  } catch (err) {
    showToast('加载失败: ' + err.message, 'error');
  }
}

// ── Navigation ──

function setupNav(idx) {
  const prevBtn = document.getElementById('btn-prev');
  const nextBtn = document.getElementById('btn-next');

  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx >= allSubmissions.length - 1;

  prevBtn.onclick = () => {
    if (idx > 0) window.location.href = `/grade/${allSubmissions[idx - 1].id}`;
  };
  nextBtn.onclick = () => {
    if (idx < allSubmissions.length - 1) window.location.href = `/grade/${allSubmissions[idx + 1].id}`;
  };
}

// ── Render Score Panel ──

function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = textarea.scrollHeight + 'px';
}

async function regradeQuestion(qid) {
  const modelSelect = document.getElementById('regrade-model-select');
  const model = modelSelect ? modelSelect.value : null;

  // Find the button and row in UI
  const row = document.querySelector(`.score-item[data-qid="${qid}"]`);
  const btn = row?.querySelector('.btn-regrade-question');
  if (!btn) return;

  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<div class="spinner-sm"></div>';

  try {
    const res = await fetch(`${API}/api/submissions/${submissionId}/ai-grade-question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: qid, model }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '重评失败');
    }

    const data = await res.json();
    showToast(`第 ${qid} 题重评完成！`, 'success');

    // Update state and refresh panel
    currentGrade = data.grade;
    renderScorePanel();
  } catch (err) {
    showToast(`重评失败: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

function renderScorePanel() {
  const container = document.getElementById('score-items');

  if (!currentGrade || !currentGrade.questions) {
    container.innerHTML = `
      <div class="empty-state" style="padding:30px 20px;">
        <div class="icon">🤖</div>
        <h3>尚未 AI 批改</h3>
        <p>请先在 Dashboard 触发 AI 批改</p>
      </div>`;
    document.getElementById('total-score').textContent = '— / 120';
    return;
  }

  // Group by main question
  const groups = {};
  for (const q of currentGrade.questions) {
    const mainQ = q.question_id.replace(/[a-z]$/, '');
    if (!groups[mainQ]) groups[mainQ] = [];
    groups[mainQ].push(q);
  }

  let html = '';
  for (const [mainQ, questions] of Object.entries(groups)) {
    const groupTotal = questions.reduce((s, q) => s + q.awarded_score, 0);
    const groupMax = questions.reduce((s, q) => s + q.max_score, 0);
    html += `<div class="question-group">
      <div class="question-group-header">
        <span>第 ${mainQ} 题</span>
        <span class="mono">${groupTotal} / ${groupMax}</span>
      </div>`;

    for (const q of questions) {
      const statusIcon = q.needs_review ? '⚠️' : (q.is_correct ? '✅' : '❌');
      const reviewClass = q.needs_review ? 'needs-review' : '';
      html += `
        <div class="score-item ${reviewClass}" data-qid="${q.question_id}">
          <span class="q-id">${q.question_id}</span>
          <input type="number" class="score-input" value="${q.awarded_score}"
                 min="0" max="${q.max_score}" data-qid="${q.question_id}" data-max="${q.max_score}">
          <span class="max-score">/ ${q.max_score}</span>
          <div class="score-item-actions" style="margin-left: auto; display: flex; align-items: center; gap: 8px;">
            <button class="btn-regrade-question" data-qid="${q.question_id}" title="AI 重新批改此小题">🔄</button>
            <span class="status-icon" title="${q.reasoning || ''}">${statusIcon}</span>
          </div>
        </div>
        ${q.error_description && !q.is_correct ? `<div class="score-item-details" style="color:var(--red); padding-bottom: 2px;">⚠ ${q.error_description}</div>` : ''}
        <textarea class="reason-textarea" data-qid="${q.question_id}" placeholder="输入评分理由...">${q.reasoning || ''}</textarea>`;
    }
    html += '</div>';
  }

  container.innerHTML = html;
  updateTotalScore();

  // Listen for score changes
  container.querySelectorAll('.score-input').forEach(input => {
    input.addEventListener('change', () => {
      const qid = input.dataset.qid;
      const max = Number(input.dataset.max);
      let val = Number(input.value);
      if (val < 0) val = 0;
      if (val > max) val = max;
      input.value = val;

      // Update in currentGrade
      const q = currentGrade.questions.find(q => q.question_id === qid);
      if (q) {
        q.awarded_score = val;
        q.is_correct = val === q.max_score;
      }
      
      // Update UI in real-time
      const row = container.querySelector(`.score-item[data-qid="${qid}"]`);
      if (row) {
        const statusIconSpan = row.querySelector('.status-icon');
        const statusIcon = q.needs_review ? '⚠️' : (q.is_correct ? '✅' : '❌');
        if (statusIconSpan) statusIconSpan.textContent = statusIcon;
        
        if (q.needs_review) {
          row.classList.add('needs-review');
        } else {
          row.classList.remove('needs-review');
        }
      }
      
      updateTotalScore();
    });
  });

  // Listen for reason changes with auto-resizing textareas
  container.querySelectorAll('.reason-textarea').forEach(textarea => {
    // Initial auto-resize
    autoResizeTextarea(textarea);

    textarea.addEventListener('input', () => {
      autoResizeTextarea(textarea);
      const qid = textarea.dataset.qid;
      const q = currentGrade.questions.find(q => q.question_id === qid);
      if (q) {
        q.reasoning = textarea.value;
      }
    });
  });

  // Listen for per-question regrade clicks
  container.querySelectorAll('.btn-regrade-question').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const qid = btn.dataset.qid;
      regradeQuestion(qid);
    });
  });
}

function updateTotalScore() {
  if (!currentGrade || !currentGrade.questions) return;
  const total = currentGrade.questions.reduce((s, q) => s + q.awarded_score, 0);
  currentGrade.total_score = total;
  const maxScore = currentGrade.questions.reduce((s, q) => s + (q.max_score || 0), 0);
  document.getElementById('total-score').textContent = `${total} / ${maxScore}`;
}

// ── Save & Finalize ──

document.getElementById('btn-save').addEventListener('click', async () => {
  if (!currentGrade) return;
  try {
    const res = await fetch(`${API}/api/submissions/${submissionId}/grade`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grade: currentGrade, graded_by: 'TA' }),
    });
    if (!res.ok) throw new Error('保存失败');
    showToast('评分已保存 ✅', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('btn-finalize').addEventListener('click', async () => {
  if (!currentGrade) return;
  if (!confirm('确认锁定这份卷子的评分？锁定后不可修改。')) return;

  try {
    // Save first
    await fetch(`${API}/api/submissions/${submissionId}/grade`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grade: currentGrade, graded_by: 'TA' }),
    });
    // Then finalize
    await fetch(`${API}/api/submissions/${submissionId}/finalize`, { method: 'PUT' });
    showToast('评分已锁定 🔒', 'success');
    // Navigate to next
    const idx = allSubmissions.findIndex(s => s.id === submissionId);
    if (idx < allSubmissions.length - 1) {
      setTimeout(() => window.location.href = `/grade/${allSubmissions[idx + 1].id}`, 800);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ── AI Re-grade ──

document.getElementById('btn-regrade').addEventListener('click', async () => {
  if (!confirm('确认要用 AI 重新批改这份卷子？当前评分将被覆盖。')) return;

  const btn = document.getElementById('btn-regrade');
  btn.disabled = true;
  btn.textContent = '⏳ 正在重评...';

  // Show loading in score panel
  document.getElementById('score-items').innerHTML = `
    <div class="empty-state" style="padding:40px 20px;">
      <div class="spinner" style="margin:0 auto 12px;"></div>
      <p>AI 正在重新批改...</p>
    </div>`;

  try {
    const res = await fetch(`${API}/api/submissions/${submissionId}/ai-grade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: document.getElementById('regrade-model-select').value }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }
    const data = await res.json();
    showToast(`AI 重评完成！(${data.model})`, 'success');

    // Reload submission data
    const subRes = await fetch(`${API}/api/submissions/${submissionId}`);
    submission = await subRes.json();
    currentGrade = submission.ai_grade || null;
    renderScorePanel();

    // Update header
    document.getElementById('nav-student').textContent =
      `${submission.student_name || '未知'} (${submission.student_id || '—'})`;
  } catch (err) {
    showToast('AI 重评失败: ' + err.message, 'error');
    // Restore score panel
    renderScorePanel();
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 AI 重评';
  }
});

// ── Chat ──

async function loadChat() {
  try {
    const res = await fetch(`${API}/api/submissions/${submissionId}/chat`);
    const messages = await res.json();
    const container = document.getElementById('chat-messages');

    if (messages.length > 0) {
      // Keep the welcome message and add history
      for (const msg of messages) {
        appendChatMessage(msg.role, msg.content);
      }
    }
  } catch (err) {
    console.error('Failed to load chat:', err);
  }
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  appendChatMessage('user', message);

  // Show typing indicator
  const typingId = appendChatMessage('assistant', '<div class="spinner" style="width:16px;height:16px;"></div>');

  try {
    const res = await fetch(`${API}/api/submissions/${submissionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    // Remove typing indicator and show reply
    document.getElementById(typingId)?.remove();
    appendChatMessage('assistant', data.reply);

    // Render MathJax if present
    if (window.MathJax) MathJax.typesetPromise();
  } catch (err) {
    document.getElementById(typingId)?.remove();
    appendChatMessage('assistant', `❌ 错误: ${err.message}`);
  }
}

function appendChatMessage(role, content) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  const id = 'msg-' + Date.now() + Math.random().toString(36).slice(2, 6);
  div.id = id;
  div.className = `chat-message ${role}`;
  div.innerHTML = content;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

document.getElementById('btn-send-chat').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// ── Toast ──
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ── Model Selector ──
async function loadModelConfig() {
  try {
    const res = await fetch(`${API}/api/model`);
    const data = await res.json();
    const select = document.getElementById('regrade-model-select');
    if (!select) return;
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

document.getElementById('regrade-model-select').addEventListener('change', async (e) => {
  try {
    const res = await fetch(`${API}/api/model`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: e.target.value }),
    });
    if (!res.ok) throw new Error('切换失败');
    showToast(`重评模型已切换为 ${e.target.value}`, 'success');
  } catch (err) {
    showToast('重评模型切换失败', 'error');
  }
});

// ── Drag-to-scroll (Grab-to-pan) for PDF Canvas ──
function setupDragToScroll() {
  const wrapper = document.getElementById('pdf-canvas-wrapper');
  if (!wrapper) return;

  let isDown = false;
  let startX;
  let startY;
  let scrollLeft;
  let scrollTop;

  wrapper.addEventListener('mousedown', (e) => {
    // Only trigger drag on left-click
    if (e.button !== 0) return;
    isDown = true;
    wrapper.classList.add('grabbing');
    startX = e.pageX - wrapper.offsetLeft;
    startY = e.pageY - wrapper.offsetTop;
    scrollLeft = wrapper.scrollLeft;
    scrollTop = wrapper.scrollTop;
  });

  wrapper.addEventListener('mouseleave', () => {
    isDown = false;
    wrapper.classList.remove('grabbing');
  });

  wrapper.addEventListener('mouseup', () => {
    isDown = false;
    wrapper.classList.remove('grabbing');
  });

  wrapper.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - wrapper.offsetLeft;
    const y = e.pageY - wrapper.offsetTop;
    const walkX = (x - startX) * 1.5; // Scroll speed multiplier
    const walkY = (y - startY) * 1.5;
    wrapper.scrollLeft = scrollLeft - walkX;
    wrapper.scrollTop = scrollTop - walkY;
  });
}

// ── Collapsible Chat Sidebar ──
function setupChatToggle() {
  const toggleBtn = document.getElementById('btn-toggle-chat');
  const layout = document.querySelector('.grading-layout');
  if (!toggleBtn || !layout) return;

  // Read initial preference from localStorage
  const isCollapsed = localStorage.getItem('chatCollapsed') === 'true';
  if (isCollapsed) {
    layout.classList.add('chat-collapsed');
    toggleBtn.textContent = '💬 显示聊天';
    toggleBtn.classList.remove('btn-primary');
    toggleBtn.classList.add('btn-secondary');
  } else {
    toggleBtn.textContent = '💬 隐藏聊天';
    toggleBtn.classList.remove('btn-secondary');
    toggleBtn.classList.add('btn-primary'); // Highlight when open
  }

  toggleBtn.addEventListener('click', () => {
    const collapsed = layout.classList.toggle('chat-collapsed');
    localStorage.setItem('chatCollapsed', collapsed);
    if (collapsed) {
      toggleBtn.textContent = '💬 显示聊天';
      toggleBtn.classList.remove('btn-primary');
      toggleBtn.classList.add('btn-secondary');
    } else {
      toggleBtn.textContent = '💬 隐藏聊天';
      toggleBtn.classList.remove('btn-secondary');
      toggleBtn.classList.add('btn-primary');
    }
  });
}

// ── Init ──
loadModelConfig();
loadSubmission();
setupDragToScroll();
setupChatToggle();
