// Groups a venue name into Museum / Auction House / Gallery / Public Art / Other.
// Shared by the website (photo view) and the server (Model Quality dashboard) so both always agree.
// Keyword based: it looks at the words in the location name, not at Google's place category.
(function (root) {
  const LOCATION_TYPES = ['Museum', 'Auction House', 'Gallery', 'Public Art', 'Other'];

  function classifyLocation(loc) {
    const t = ' ' + String(loc || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim() + ' ';
    const has = re => re.test(t);
    if (has(/\b(christie'?s|sotheby'?s|bonhams|auction|auctions|auctioneers|heritage auctions|doyle|swann|artcurial|ketterer|phillips (auction|auctioneers))\b/)) return 'Auction House';
    if (has(/\b(museum|museums|museo|museu|musee|muzeum|museet|pinakothek|pinacoteca|kunstmuseum|kunsthaus|kunsthalle|louvre|uffizi|prado|hermitage|orsay|orangerie|guggenheim|moma|tate|metropolitan|national gallery|art institute|institute of art|art gallery of|gallery of art|center for the arts|centre pompidou|pompidou|getty|whitney|frick|smithsonian|albertina|belvedere|mauritshuis|accademia|galleria nazionale|collection|art center|art centre)\b/)) return 'Museum';
    if (has(/\b(gallery|galleries|galerie|galleria|galeria|gagosian|zwirner|hauser|perrotin|lisson|white cube|kunstverein)\b/)) return 'Gallery';
    if (has(/\b(street|streets|st|avenue|ave|boulevard|blvd|road|rd|plaza|square|park|parks|garden|gardens|station|subway|metro|airport|bridge|mural|murals|wall|walls|alley|pier|waterfront|sculpture|outdoor|public|graffiti|memorial|courtyard)\b/)) return 'Public Art';
    return 'Other';
  }

  const api = { LOCATION_TYPES, classifyLocation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LocationType = api;
})(typeof window !== 'undefined' ? window : globalThis);
