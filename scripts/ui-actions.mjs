/** Open the existing creation form in either the old direct-button UI or the diary menu UI. */
export async function openCreateEventDrawer(page, { timeout = 15_000 } = {}) {
  const legacyButton = page.getByRole('button', { name: '新建人生节点', exact: true })
  const menuButton = page.getByRole('button', { name: '添加与日记管理', exact: true })
  await legacyButton.or(menuButton).first().waitFor({ state: 'visible', timeout })
  if (await menuButton.isVisible()) {
    await menuButton.click()
    await page.getByRole('dialog', { name: '记录操作', exact: true })
      .getByRole('menuitem', { name: '新建人生节点', exact: true }).click()
  } else {
    await legacyButton.click()
  }
  await page.getByRole('dialog', { name: '新建人生节点', exact: true }).waitFor({ state: 'visible', timeout })
}
