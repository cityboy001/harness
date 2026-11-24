const css = `*{box-sizing:border-box}body{margin:0;padding:clamp(18px,6vw,55px);background:#eaf4fd;color:#1e3146;font:15px/1.55 system-ui,sans-serif;min-height:100vh}main{max-width:520px;margin:auto;padding:clamp(15px,4vw,33px);background:#fff;border:1px solid #d8e6f3;border-radius:20px;box-shadow:0 12px 40px #1636590b}h1{margin:3px 0 18px;font-size:32px;line-height:1.2}.label{color:#305e88;font-weight:600}form,.filters,li{display:flex;gap:8px;align-items:center;flex-wrap:wrap}input:not([type=checkbox]){flex:1;min-width:100px;padding:8px;font:inherit;border:1px solid #b8c9da;border-radius:8px;color:inherit}button{padding:7px 9px;border:1px solid #b8c9da;border-radius:8px;background:white;color:#264d73;font:inherit;cursor:pointer}form button{background:#2d5e8c;color:white;border-color:#2d5e8c}.filters{margin-top:16px}[aria-pressed=true]{background:#e2f0ff;border-color:#5c7fa6}ul{padding:0;margin:12px 0 0;list-style:none}li{padding:8px 0;border-bottom:1px solid #e6edf5}li span{flex:1;overflow-wrap:anywhere}li:has(input:checked) span{text-decoration:line-through;color:#53677a}#error{color:#a32b3c}`;
const browser = `
const form = document.querySelector('form');
const list = document.querySelector('ul');
const error = document.querySelector('#error');
let filter = 'all';
async function call(path, method = 'GET', body) {
  const reply = await fetch('/api/tasks' + path, {method, body: body ? JSON.stringify(body) : undefined});
  if (!reply.ok) throw new Error('操作失败，请重试。');
  return reply.json();
}
async function action(work) {
  try { error.textContent = ''; await work(); await render(); }
  catch (problem) { error.textContent = problem.message; }
}
function control(text, handler) {
  const button = document.createElement('button');
  button.textContent = text;
  button.onclick = handler;
  return button;
}
async function render() {
  const tasks = (await call('')).filter(item => filter === 'all' || item.done === (filter === 'done'));
  document.querySelector('#empty').hidden = tasks.length > 0;
  list.replaceChildren(...tasks.map(task => {
    const row = document.createElement('li');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = task.done;
    check.setAttribute('aria-label', task.title);
    check.onchange = () => action(() => call('/' + task.id, 'PATCH', {done: check.checked}));
    const name = document.createElement('span');
    name.textContent = task.title;
    const edit = control('编辑', () => {
      const input = document.createElement('input');
      input.value = task.title;
      input.maxLength = 120;
      input.setAttribute('aria-label', '编辑待办');
      name.replaceWith(input);
      input.focus();
      edit.textContent = '保存';
      edit.onclick = () => action(() => call('/' + task.id, 'PATCH', {title: input.value}));
    });
    row.append(check, name, edit, control('删除', () => action(() => call('/' + task.id, 'DELETE'))));
    return row;
  }));
}
form.onsubmit = event => {
  event.preventDefault();
  const title = form.elements.title.value.trim();
  if (title) void action(async () => { await call('', 'POST', {title}); form.reset(); });
};
const filters = document.querySelectorAll('[data-filter]');
filters.forEach(button => button.onclick = () => {
  filter = button.dataset.filter;
  filters.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  void action(async () => {});
});
void action(async () => {});
`;
const backend = `
function handle(request) {
  const {method, path, body} = request;
  if (path === '/api/tasks' && method === 'GET') return {status: 200, body: db.list('tasks')};
  if (path === '/api/tasks' && method === 'POST') {
    if (typeof body?.title !== 'string' || !body.title.trim() || body.title.length > 120)
      return {status: 400, body: {error: '请输入待办名称'}};
    return {status: 201, body: db.insert('tasks', {title: body.title.trim(), done: false})};
  }
  const id = path.split('/')[3];
  if (id && method === 'PATCH') {
    const patch = {};
    if (typeof body?.title === 'string' && body.title.trim() && body.title.length <= 120) patch.title = body.title.trim();
    if (typeof body?.done === 'boolean') patch.done = body.done;
    const task = db.update('tasks', id, patch);
    return {status: task ? 200 : 404, body: task};
  }
  if (id && method === 'DELETE') return {status: 200, body: db.remove('tasks', id)};
  return {status: 404, body: {error: '未找到接口'}};
}`;
export function demoCompletion(_config, messages) {
  const revised = messages[0].content.includes('immutable current version');
  const filters = revised ? '<div class="filters"><button data-filter="all" aria-pressed="true">全部</button><button data-filter="open">待完成</button><button data-filter="done">已完成</button></div>' : '';
  const page = '<html lang="zh-CN"><head><title>每日待办</title><link rel="stylesheet" href="style.css"></head><body><main><span class="label">待办清单</span><h1>每日待办</h1><form><input name="title" aria-label="新待办" placeholder="写下一件要做的事" required maxlength="120"><button>添加</button></form>' + filters + '<ul></ul><p id="empty" hidden>还没有待办。</p><p id="error" role="status"></p></main><script src="app.js"></script></body></html>';
  return JSON.stringify({
    summary: revised ? '演示版已添加按完成状态筛选，现有任务数据已保留。' : '已生成每日待办演示，可以新增、编辑、完成或删除任务。',
    [revised ? 'changes' : 'files']: revised ? { 'index.html': page } : {
      'index.html': page,
      'style.css': css,
      'app.js': browser,
      'server.js': backend
    }
  });
}
