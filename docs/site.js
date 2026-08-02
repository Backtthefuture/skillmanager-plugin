document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = document.querySelector(button.dataset.copy)
    if (!target) return
    const text = Array.from(target.querySelectorAll('.command span:last-child'))
      .map((element) => element.textContent.trim())
      .join('\n')
    let copied = false
    try {
      await navigator.clipboard.writeText(text)
      copied = true
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      copied = document.execCommand('copy')
      textarea.remove()
    }
    const previous = button.textContent
    button.textContent = copied ? '已复制' : '请手动复制'
    window.setTimeout(() => { button.textContent = previous }, 1400)
  })
})
