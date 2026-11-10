// electron 由 Obsidian (Electron) 在執行期提供，建置時列為 external，專案不安裝它的型別。
// 使用處只宣告實際用到的 API (見 UtilityProcessHost 的 ElectronLike、SettingsTab 的 FolderDialog)。
declare module 'electron' {
    const electron: unknown;
    export default electron;
}
