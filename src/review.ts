export {}

const heading = document.createElement('h1')
heading.textContent = 'Decision Review'

const status = document.createElement('p')
status.textContent = 'Scaffold only. Open a synthetic review file to inspect its reference.'

const reference = document.createElement('pre')
document.body.append(heading, status, reference)

if (orca.document) {
  const session = await orca.document.session<string>({ merge: (_base, outside) => outside })
  reference.textContent = session.value
  session.onReplace((value) => {
    reference.textContent = value
  })
}
