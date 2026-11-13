/**
 * dsh-session-communicate — client half.
 * Sidebar panel: 选两个会话、设一个时间和轮次、给双方定一个目的，然后让它们自己聊。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-communicate',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState

    var PANEL_ID = 'session-communicate'
    var API = '/session-communicate/api/'

    var CSS = [
      '.sc-root{padding:14px;height:100%;overflow:auto;font-size:13px;color:var(--dsw-alias-label-primary,#1f2937)}',
      '.sc-title{font-size:15px;font-weight:700;margin-bottom:4px}',
      '.sc-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.5;margin-bottom:12px}',
      '.sc-row{display:flex;gap:8px;align-items:center;margin-bottom:9px}',
      '.sc-row label{flex:none;width:74px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.sc-row select,.sc-row input[type=text],.sc-row input[type=number],.sc-row input[type=time]{flex:1;min-width:0;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:transparent;color:inherit;font-size:12px}',
      '.sc-area{width:100%;box-sizing:border-box;min-height:72px;padding:7px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:transparent;color:inherit;font-size:12px;resize:vertical}',
      '.sc-btn{border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:transparent;color:inherit;border-radius:6px;padding:5px 11px;font-size:12px;cursor:pointer}',
      '.sc-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-brand-primary,#2563eb)}',
      '.sc-btn.primary{background:#2563eb !important;border-color:#2563eb !important;color:#fff !important}',
      '.sc-logbox{margin-top:6px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);max-height:220px;overflow:auto;padding:8px}',
      '.sc-logbox pre{margin:0;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.sc-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.sc-hr{height:1px;background:var(--dsw-alias-border-l2,#e5e7eb);margin:14px 0}',
      '.sc-h{font-size:12px;font-weight:650;margin:10px 0 6px}',
      '.sc-msg{border-left:3px solid var(--dsw-alias-brand-primary,#2563eb);padding:4px 8px;margin-bottom:6px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));border-radius:0 6px 6px 0}',
      '.sc-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9ca3af);margin-bottom:2px}',
      '.sc-note{font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.5}',
      '.sc-err{color:#dc2626;font-size:11.5px;margin-top:6px;word-break:break-word}',
      '.sc-ok{color:#16a34a;font-size:11.5px;margin-top:6px}',
      '.sc-entry{width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:14px}',
    ].join('\n')

    function ensureCss() {
      if (typeof document === 'undefined' || document.getElementById('sc-css')) return
      var tag = document.createElement('style')
      tag.id = 'sc-css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function api(pathName, init) {
      return fetch(API + pathName, Object.assign({ headers: { 'content-type': 'application/json' } }, init || {}))
        .then(function (res) { return res.json().catch(function () { return { ok: false, error: 'bad json' } }) })
    }

    function Panel() {
      var cfgState = useState(null)
      var cfg = cfgState[0]
      var setCfg = cfgState[1]
      var sessionsState = useState([])
      var sessions = sessionsState[0]
      var setSessions = sessionsState[1]
      var statusState = useState({ running: false, transcript: [] })
      var status = statusState[0]
      var setStatus = statusState[1]
      var toastState = useState('')
      var toast = toastState[0]
      var setToast = toastState[1]
      var logState = useState([])
      var logLines = logState[0]
      var setLogLines = logState[1]
      var busyState = useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var load = useCallback(function () {
        api('config').then(function (r) { if (r.ok) setCfg(r.config) })
        api('sessions').then(function (r) { if (r.ok) setSessions(r.sessions || []) })
      }, [setCfg, setSessions])

      useEffect(function () {
        load()
        var timer = setInterval(function () {
          api('status').then(function (r) { if (r.ok) setStatus(r.state || {}) })
          api('log?lines=100').then(function (r) { if (r.ok) setLogLines(r.lines || []) })
        }, 3000)
        api('status').then(function (r) { if (r.ok) setStatus(r.state || {}) })
        return function () { clearInterval(timer) }
      }, [load])

      var patch = function (key, value) {
        setCfg(Object.assign({}, cfg, (function () { var o = {}; o[key] = value; return o })()))
      }

      var save = function () {
        setBusy(true)
        api('config', { method: 'POST', body: JSON.stringify(cfg) })
          .then(function (r) {
            if (r.ok) { setCfg(r.config); setToast('已保存') } else setToast('保存失败：' + (r.error || 'unknown'))
          })
          .finally(function () { setBusy(false) })
      }

      var runNow = function () {
        setBusy(true)
        api('run', { method: 'POST', body: '{}' })
          .then(function (r) {
            if (r.ok) setToast('已开始，回话在下方逐条出现')
            else setToast('启动失败：' + (r.error || 'unknown'))
          })
          .finally(function () { setBusy(false) })
      }

      var preview = function (which) {
        var id = which === 'A' ? cfg.sessionA : cfg.sessionB
        if (!id) return
        api('preview?sessionId=' + encodeURIComponent(id)).then(function (r) {
          if (!r.ok) { setToast('读不到标题：' + (r.error || 'unknown')); return }
          patch(which === 'A' ? 'nameA' : 'nameB', (r.title || '').slice(0, 24) || id.slice(0, 16))
          setToast(which === 'A' ? '已按首条消息填名' : '已按首条消息填名')
        })
      }

      var openLogDir = function () {
        api('opendir', { method: 'POST', body: '{}' })
          .then(function (r) { setToast(r.ok ? '已打开对话记录目录' : '打不开：' + (r.error || 'unknown')) })
          .catch(function () { setToast('打不开日志目录') })
      }

      if (!cfg) return h('div', { className: 'sc-root' }, '读取配置中…')

      var pickOptions = sessions.map(function (s) {
        return h('option', { key: s.id, value: s.id }, s.id.slice(0, 30) + ' · ' + s.updatedAt.slice(5, 16))
      })
      pickOptions.unshift(h('option', { key: '__none', value: '' }, '— 选择会话 —'))

      var transcript = (status.transcript || []).map(function (m, i) {
        return h('div', { key: i, className: 'sc-msg' },
          h('div', { className: 'sc-meta' }, (m.from === 'A' ? (cfg.nameA || 'A') : (cfg.nameB || 'B')) + ' · ' + String(m.at || '').slice(11, 16)),
          m.text)
      })

      return h('div', { className: 'sc-root' },
        h('div', { className: 'sc-title' }, '两个会话对谈'),
        h('div', { className: 'sc-sub' }, '每天到点让两个已经存在的 DSH 会话按轮次对话。双方每一句都会收到同一份规则（目的、轮次、字数上限）。'),

        h('div', { className: 'sc-row' },
          h('label', null, '会话 A'),
          h('select', { value: cfg.sessionA, onChange: function (e) { patch('sessionA', e.target.value) } }, pickOptions)),
        h('div', { className: 'sc-row' },
          h('label', null, '名称 A'),
          h('input', { type: 'text', value: cfg.nameA, onChange: function (e) { patch('nameA', e.target.value) } }),
          h('button', { className: 'sc-btn', onClick: function () { preview('A') } }, '取名')),
        h('div', { className: 'sc-row' },
          h('label', null, '会话 B'),
          h('select', { value: cfg.sessionB, onChange: function (e) { patch('sessionB', e.target.value) } }, pickOptions)),
        h('div', { className: 'sc-row' },
          h('label', null, '名称 B'),
          h('input', { type: 'text', value: cfg.nameB, onChange: function (e) { patch('nameB', e.target.value) } }),
          h('button', { className: 'sc-btn', onClick: function () { preview('B') } }, '取名')),

        h('div', { className: 'sc-row' },
          h('label', null, '发起方'),
          h('select', { value: cfg.initiator, onChange: function (e) { patch('initiator', e.target.value) } },
            h('option', { value: 'A' }, 'A 先说'),
            h('option', { value: 'B' }, 'B 先说')),
          h('label', { style: { width: 'auto' } }, '轮次'),
          h('input', { type: 'number', min: 1, max: 20, value: cfg.rounds, onChange: function (e) { patch('rounds', Number(e.target.value)) } }),
          h('label', { style: { width: 'auto' } }, '时间'),
          h('input', { type: 'time', value: cfg.time, onChange: function (e) { patch('time', e.target.value) } })),

        h('div', { className: 'sc-row', style: { alignItems: 'flex-start' } },
          h('label', null, '目的'),
          h('textarea', { className: 'sc-area', value: cfg.purpose, placeholder: '例如：把今天看到的视频讲给对方，并问对方怎么看。', onChange: function (e) { patch('purpose', e.target.value) } })),

        h('div', { className: 'sc-row' },
          h('label', null, '每条字数'),
          h('input', { type: 'number', min: 100, max: 4000, step: 100, value: cfg.messageChars, onChange: function (e) { patch('messageChars', Number(e.target.value)) } }),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
            h('label', { style: { width: 'auto', flex: 'none' } }, '启用'),
            h('input', { type: 'checkbox', checked: !!cfg.enabled, onChange: function (e) { patch('enabled', e.target.checked) } })),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'sc-btn primary', disabled: busy, onClick: save }, '保存'),
          h('button', { className: 'sc-btn', disabled: busy, onClick: runNow }, '立即开始')),

        toast ? h('div', { className: 'sc-ok' }, toast) : null,

        h('div', { className: 'sc-hr' }),
        h('div', { className: 'sc-h' }, '状态'),
        h('div', { className: 'sc-note' },
          (status.running ? '进行中' : '空闲') +
          (status.lastResult ? ' · ' + status.lastResult : '') +
          (status.nextRunAt ? ' · 下次 ' + String(status.nextRunAt).replace('T', ' ').slice(0, 16) : '')),
        status.error ? h('div', { className: 'sc-err' }, status.error) : null,

        h('div', { className: 'sc-row', style: { marginTop: 8 } },
          h('div', { className: 'sc-h', style: { margin: 0 } }, '历史记录（最近 100 行）'),
          h('span', { style: { flex: 1 } }),
          h('button', { className: 'sc-btn', onClick: openLogDir }, '看所有记录')),
        h('div', { className: 'sc-logbox' },
          h('pre', null, logLines.length ? logLines.slice(-100).join('\n') : '还没有记录')),

        transcript.length ? h('div', null, h('div', { className: 'sc-h' }, '本次对话'), transcript) : null,
      )
    }

    function Entry(props) {
      var size = typeof props.size === 'number' ? props.size : 18
      return h('span', {
        title: '会话对谈',
        className: 'sc-entry',
        style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.82) + 'px' },
      }, '💬')
    }

    function apply(ctx) {
      ensureCss()
      ctx.slots.inject('main', function () {
        return ctx.slots.inject('sidebar.panellist', function () {
          var stopMain = ctx.slots.register({ name: 'main', key: PANEL_ID, inject: function () { return {} } }, Panel)
          var stopEntry = ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 47, label: function () { return '会话对谈' } }, Entry)
          return function () {
            try { stopMain && stopMain() } catch (e) {}
            try { stopEntry && stopEntry() } catch (e) {}
          }
        })
      })
    }

    return { inject: ['slots'], apply: apply }
  },
})
