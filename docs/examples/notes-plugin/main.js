// Scratch Notes — a local Alethe plugin. Plain JavaScript, no build step.
// Its stylesheet is declared as "styles" in plugin.json and loaded by Alethe.
;(function () {
  var api = window.alethe
  if (!api) return

  var React = api.react
  var notes = []
  var listeners = new Set()
  var storage = null
  var nextId = 1
  var translate = function (key) {
    return key
  }

  function save() {
    if (storage) storage.set('notes', notes)
  }

  function emit() {
    listeners.forEach(function (listener) {
      listener()
    })
  }

  function addNote(cwd) {
    notes.unshift({
      id: String(nextId++),
      where: cwd || '-',
      when: new Date().toLocaleTimeString(),
    })
    save()
    emit()
  }

  function removeNote(id) {
    notes = notes.filter(function (note) {
      return note.id !== id
    })
    save()
    emit()
  }

  function NotesPanel(props) {
    var state = React.useState(0)
    var setVersion = state[1]

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

    var children = [
      React.createElement(
        'button',
        {
          key: 'add',
          type: 'button',
          onClick: function () {
            addNote(props.cwd)
          },
        },
        translate('add'),
      ),
    ]

    if (notes.length === 0) {
      children.push(
        React.createElement(
          'p',
          { key: 'empty', className: 'alethe-notes__empty' },
          translate('empty'),
        ),
      )
    } else {
      notes.forEach(function (note) {
        children.push(
          React.createElement(
            'div',
            { key: note.id, className: 'alethe-notes__item' },
            translate('noteIn') + ' ' + note.where,
            React.createElement('span', { className: 'alethe-notes__when' }, note.when),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'alethe-notes__remove',
                'aria-label': translate('remove'),
                onClick: function () {
                  removeNote(note.id)
                },
              },
              '×',
            ),
          ),
        )
      })
    }

    return React.createElement('div', { className: 'alethe-notes' }, children)
  }

  api.registerPlugin('example.notes', {
    activate: function (context) {
      translate = context.t
      storage = context.storage

      storage.get('notes', []).then(function (stored) {
        notes = Array.isArray(stored) ? stored : []
        notes.forEach(function (note) {
          var n = Number(note.id)
          if (n >= nextId) nextId = n + 1
        })
        emit()
      })

      context.registerMessages('en', {
        title: 'Notes',
        addCommand: 'Notes: add a note',
        add: 'Add a note',
        empty: 'No notes yet. Add one, or run the command from Ctrl+P.',
        noteIn: 'Note taken in',
        remove: 'Remove note',
      })
      context.registerMessages('pt-BR', {
        title: 'Notas',
        addCommand: 'Notas: adicionar nota',
        add: 'Adicionar nota',
        empty: 'Nenhuma nota ainda. Adicione uma, ou rode o comando pelo Ctrl+P.',
        noteIn: 'Nota feita em',
        remove: 'Remover nota',
      })

      context.registerView('example.notes.panel', NotesPanel)
      context.registerCommand('example.notes.add', function () {
        addNote(null)
      })
    },
  })
})()
