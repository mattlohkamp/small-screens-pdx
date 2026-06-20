"use client";
import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import styles from "./VenueMap.module.css";

interface Venue {
  id: string;
  name: string;
  neighborhood: string;
  website: string;
  lat: number;
  lng: number;
}

// Webpack mangles leaflet's default icon paths — fix by pointing at the CDN copies
const defaultIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function FitBounds({ coords, selectionKey }: { coords: [number, number][]; selectionKey: string }) {
  const map = useMap();
  useEffect(() => {
    if (coords.length > 0) {
      map.fitBounds(coords, { padding: [40, 40] });
    }
  // selectionKey changes whenever the selection changes, triggering a refit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, selectionKey]);
  return null;
}

interface VenueMapProps {
  venues: Venue[];
  selectedVenues: Set<string>;
  onVenueClick: (id: string) => void;
}

export default function VenueMap({ venues, selectedVenues, onVenueClick }: VenueMapProps) {
  useEffect(() => {
    L.Marker.prototype.options.icon = defaultIcon;
  }, []);

  const withCoords = venues.filter((v) => v.lat != null && v.lng != null);
  if (withCoords.length === 0) return null;

  const allCoords: [number, number][] = withCoords.map((v) => [v.lat, v.lng]);

  const activeCoords: [number, number][] =
    selectedVenues.size > 0
      ? withCoords.filter((v) => selectedVenues.has(v.id)).map((v) => [v.lat, v.lng])
      : allCoords;

  const selectionKey =
    selectedVenues.size > 0 ? [...selectedVenues].sort().join(",") : "__all__";

  return (
    <div className={styles.mapWrap}>
      <MapContainer
        center={allCoords[0]}
        zoom={13}
        className={styles.map}
        scrollWheelZoom={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds coords={activeCoords} selectionKey={selectionKey} />
        {withCoords.map((venue) => {
          const dimmed = selectedVenues.size > 0 && !selectedVenues.has(venue.id);
          return (
            <Marker
              key={venue.id}
              position={[venue.lat, venue.lng]}
              opacity={dimmed ? 0.25 : 1}
            >
              <Popup>
                <a
                  href={venue.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.popupVenueName}
                >
                  {venue.name}
                  <svg className={styles.externalIcon} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                    <path d="M1 1h4v1H2v6h6V5h1v4H1V1zm5 0h3v3H8V2.707L5.354 5.354l-.708-.708L7.293 2H6V1z" />
                  </svg>
                </a>
                <div className={styles.popupNeighborhood}>{venue.neighborhood}</div>
                <button
                  onClick={() => onVenueClick(venue.id)}
                  className={styles.popupBtn}
                >
                  Show only this venue
                </button>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
