declare const __DEP_RADAR_VERSION__: string

function main(): void {
  process.stdout.write(
    `dep-radar v${__DEP_RADAR_VERSION__} (scaffolding ready)\n`,
  )
  process.stdout.write(
    '业务命令尚未实现，请参考 PLAN-v2.md Step 2 之后的计划。\n',
  )
}

main()
