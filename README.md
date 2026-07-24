# Digital Reference Ontology

Holistic Ontology for semiconductor manufacturing and development, products and systems containing semiconductors and connected supply chains.

## Namespaces

The base namespace of the ontology is

```turtle
@prefix dr: <http://www.w3id.org/ecsel-dr#> .
```

The ontology further involves the following namespaces

```turtle
@prefix ecsel-dr-Cloud-AH: <http://www.w3id.org/ecsel-dr-Cloud-AH#> .
@prefix ecsel-dr-AT: <http://www.w3id.org/ecsel-dr-AT#> .
@prefix ecsel-dr-BMS: <http://www.w3id.org/ecsel-dr-BMS#> .
@prefix ecsel-dr-CO2Savings: <http://www.w3id.org/ecsel-dr-CO2Savings#> .
@prefix ecsel-dr-DF: <http://www.w3id.org/ecsel-dr-DF#> .
@prefix ecsel-dr-GDM: <http://www.w3id.org/ecsel-dr-GDM#> .
@prefix ecsel-dr-Incoterms: <http://www.w3id.org/ecsel-dr-Incoterms#> .
@prefix ecsel-dr-OM: <http://www.w3id.org/ecsel-dr-OM#> .
@prefix ecsel-dr-OOSMP: <http://www.w3id.org/ecsel-dr-OOSMP#> .
@prefix ecsel-dr-Organization: <http://www.w3id.org/ecsel-dr-Organization#> .
@prefix ecsel-dr-Organization-ORG: <http://www.w3id.org/ecsel-dr-Organization-ORG#> .
@prefix ecsel-dr-Planning: <http://www.w3id.org/ecsel-dr-Planning#> .
@prefix ecsel-dr-PMV: <http://www.w3id.org/ecsel-dr-PMV#> .
@prefix ecsel-dr-PROD: <http://www.w3id.org/ecsel-dr-PROD#> .
@prefix ecsel-dr-Power-PWR: <http://www.w3id.org/ecsel-dr-Power-PWR#> .
@prefix ecsel-dr-RAMI40: <http://www.w3id.org/ecsel-dr-RAMI40#> .
@prefix ecsel-dr-Planning-DF: <http://www.w3id.org/ecsel-dr-Planning-DF#> .
@prefix ecsel-dr-Planning-SCP: <http://www.w3id.org/ecsel-dr-Planning-SCP#> .
@prefix ecsel-dr-SO: <http://www.w3id.org/ecsel-dr-SO#> .
```

## Dependencies

The ontology depends specifically on the following ontologies:

```turtle
@prefix time: <http://www.w3.org/2006/time#> .            # OWL-Time
@prefix sosa: <http://www.w3.org/ns/sosa/> .              # Sensor, Observation, Sample, and Actuator (SOSA) Ontology
@prefix sampling: <http://www.w3.org/ns/sosa/sampling> .  # Sensor, Observation, Sample, and Actuator (SOSA) Ontology
@prefix ssn: <http://www.w3.org/ns/ssn/> .                # Semantic Sensor Network Ontology
@prefix ssn-system: <http://www.w3.org/ns/ssn/systems/> . # System capabilities, operating ranges, and survival ranges ontology
@prefix ssn-ext: <http://www.w3.org/ns/ssn/ext/> .        # Extensions to the SSN Ontology should be http://www.w3.org/ns/ssn/ext/
```

As of the construction of the ontology the following DBpedia Archivo snapshots were the current versions and should be used for reproduction:
- OWL-Time<br/>[@DBpedia Archivo](https://archivo.dbpedia.org/info?o=http://www.w3.org/2006/time), Snapshot: [[2020.06.10-215415](https://databus.dbpedia.org/ontologies/w3.org/2006--time/2020.06.10-215415)] Artifact: [[ttl](https://archivo.dbpedia.org/download?o=http%3A//www.w3.org/2006/time&f=ttl&v=2020.06.10-215415)]
- Sensor, Observation, Sample, and Actuator (SOSA) Ontology<br/>[@DBpedia Archivo](https://archivo.dbpedia.org/info?o=http://www.w3.org/ns/sosa/), Snapshot: [[2020.06.10-215704](https://databus.dbpedia.org/ontologies/w3.org/ns--sosa/2020.06.10-215704)] Artifact: [[ttl](https://archivo.dbpedia.org/download?o=http%3A//www.w3.org/ns/sosa/&f=ttl&v=2020.06.10-215704)]
- SOSA-Sampling<br/>[@DBpedia Archivo](https://archivo.dbpedia.org/info?o=http://www.w3.org/ns/sosa/sampling/), Snapshot: [[2024.01.24-105516](https://databus.dbpedia.org/ontologies/w3.org/ns--sosa--sampling/2024.01.24-105516)] Artifact: [[ttl](https://archivo.dbpedia.org/download?o=http%3A//www.w3.org/ns/sosa/sampling/&f=ttl&v=2024.01.24-105516)]
- Semantic Sensor Network Ontology<br/>[@DBpedia Archivo](https://archivo.dbpedia.org/info?o=http://www.w3.org/ns/ssn/), Snapshot: [[2023.04.02-001722](https://databus.dbpedia.org/ontologies/w3.org/ns--ssn/2023.04.02-001722)] Artifact: [[ttl](https://archivo.dbpedia.org/download?o=http%3A//www.w3.org/ns/ssn/&f=ttl&v=2023.04.02-001722)]
- System capabilities, operating ranges, and survival ranges ontology<br/>[@DBpedia Archivo](https://archivo.dbpedia.org/info?o=http://www.w3.org/ns/ssn/systems/), Snapshot: [[2022.03.04-203505](https://databus.dbpedia.org/ontologies/w3.org/ns--ssn--systems/2022.03.04-203505)] Artifact: [[ttl](https://archivo.dbpedia.org/download?o=http%3A//www.w3.org/ns/ssn/systems/&f=ttl&v=2022.03.04-203505)]
- Extensions to the SSN Ontology<br/>[@DBpedia Archivo](https://archivo.dbpedia.org/info?o=http://www.w3.org/ns/ssn/ext), Snapshot: [[2024.01.23-235557](https://databus.dbpedia.org/ontologies/w3.org/ns--ssn--ext/2024.01.23-235557)] Artifact: [[ttl](https://archivo.dbpedia.org/download?o=http%3A//www.w3.org/ns/ssn/ext&f=ttl&v=2024.01.23-235557)]


## Modifications (fork notice)

This repository is a fork of [tibonto/dr](https://github.com/tibonto/dr)
(Digital Reference ontology, Apache License 2.0).

Pursuant to Section 4(b) of the Apache License 2.0, notice is hereby given
that the following changes were made in this fork:

- **`DigitalReference.ttl` has been modified**: ontology fixes such as
  class reparenting (e.g. EDI_Forecast, SSO_Stocks, Available_Capacity),
  corrected copy-paste definitions, replacement of non-standard
  `rdfs:description` annotations with `rdfs:comment`, removal of unused
  phantom namespace prefixes, and declaration of real module namespaces as
  prefixes with CURIEs. See the git history for the complete list of
  changes.
- **`analysis/` was added**: the *Digital Reference Explorer*, a web
  application (Node/Express + oxigraph backend, Vite/React frontend) to
  visualize and query the ontology — see [analysis/README.md](analysis/README.md).

All original copyright and attribution notices have been retained. This
fork, including its modifications and additions, is distributed under the
same [Apache License 2.0](License.txt).
