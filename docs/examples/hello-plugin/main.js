// A local Alethe plugin: plain JavaScript, no build step, no bundler.
// Alethe injects this file over alethe-plugin:// and hands it window.alethe.
;(function () {
  var api = window.alethe
  if (!api) return

  var React = api.react
  var greetings = 0
  var listeners = new Set()

  function greet() {
    greetings += 1
    listeners.forEach(function (listener) {
      listener()
    })
  }

  function HelloPanel(props) {
    var version = React.useState(0)
    var setVersion = version[1]

    React.useEffect(function () {
      var listener = function () {
        setVersion(function (n) {
          return n + 1
        })
      }
      listeners.add(listener)
      return function () {
        listeners.delete(listener)
      }
    }, [])

    return React.createElement(
      'div',
      { style: { padding: '16px', color: 'var(--fg)', fontSize: '13px' } },
      React.createElement(
        'p',
        { style: { margin: '0 0 12px', color: 'var(--fg-muted)' } },
        'This panel comes from a plugin loaded off disk.',
      ),
      React.createElement(
        'p',
        { style: { margin: '0 0 12px' } },
        'Active project: ' + (props.projectId || 'none'),
      ),
      React.createElement(
        'p',
        { style: { margin: '0 0 12px' } },
        'Working directory: ' + (props.cwd || 'none'),
      ),
      React.createElement(
        'strong',
        { style: { color: 'var(--accent)' } },
        'Greetings so far: ' + greetings,
      ),
    )
  }

  api.registerPlugin('example.hello', {
    activate: function (context) {
      context.registerView('example.hello.panel', HelloPanel)
      context.registerCommand('example.hello.greet', greet)
    },
  })
})()
