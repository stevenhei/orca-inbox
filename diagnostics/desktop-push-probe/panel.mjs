const form = document.getElementById('probe')
const report = document.getElementById('report')
const button = form.querySelector('button')
form.addEventListener('submit', async event => {
  event.preventDefault()
  button.disabled = true
  report.textContent = 'Checking the disposable Chat and attempting one worker send…'
  try {
    const data = new FormData(form)
    const result = await orca.plugin.request('probe.send', {
      target: String(data.get('target')).trim(),
      confirmDisposable: data.has('confirmed')
    }, { timeoutMs: 45000 })
    report.textContent = JSON.stringify(result, null, 2)
  } catch (error) {
    report.textContent = 'Worker request ended without a report. Mail outcome is unknown. ' + String(error)
  } finally {
    form.reset()
    button.disabled = false
  }
})
