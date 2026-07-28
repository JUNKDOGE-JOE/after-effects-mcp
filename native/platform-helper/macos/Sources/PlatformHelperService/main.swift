import Darwin

if CommandLine.arguments.count == 2,
   CommandLine.arguments[1] == "--client-stdio" {
    exit(PlatformHelperStdioBroker.run())
}
guard CommandLine.arguments.count == 1 else { exit(64) }
PlatformHelperServiceMain.run()
