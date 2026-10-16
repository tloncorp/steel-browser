/** Route page traffic, including loopback requests, through the configured egress proxy. */
export function chromeProxyArgs(proxyUrl?: string): string[] {
  return proxyUrl ? [`--proxy-server=${proxyUrl}`, "--proxy-bypass-list=<-loopback>"] : [];
}
